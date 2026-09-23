//! Founder Stack allowlist transfer hook for Token-2022 mints.
//!
//! Every Token-2022 transfer of a mint whose TransferHook extension points at this
//! program CPIs into `execute`. The transfer succeeds only if the *destination owner*
//! has an active `AllowEntry` PDA (["allow", mint, destination_owner]).
//!
//! Extra-account resolution (stored in the ExtraAccountMetaList PDA
//! ["extra-account-metas", mint]) uses only standard on-chain data, so any client
//! that follows the SPL transfer-hook interface (spl-token JS
//! `createTransferCheckedWithTransferHookInstruction`, Meteora DBC
//! `swap2WithTransferHook`, Token-2022 itself on CPI) resolves it automatically:
//!
//!   extra[0] = PDA(program_id, [
//!       Literal("allow"),
//!       AccountKey(index = 1),                            // mint
//!       AccountData(account_index = 2, offset 32, len 32) // destination token account owner
//!   ])
//!
//! Operational note: after a Meteora DBC pool is created, the admin MUST call
//! `add_allow(pool_authority)` (the DBC pool-authority PDA owns the base vault),
//! otherwise sells into the pool fail with `NotEligible`. No special-casing here.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Account as SplTokenAccount,
};
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("3gfXWxgHN8tjJzxXGeAEiZWaixDe7ZMxXQGnpvHkQZu7");

pub const CONFIG_SEED: &[u8] = b"config";
pub const ALLOW_SEED: &[u8] = b"allow";
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";

#[program]
pub mod fs_allowlist {
    use super::*;

    /// Creates the Config PDA and the ExtraAccountMetaList for `mint`.
    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.mint = ctx.accounts.mint.key();
        config.admin = admin;
        config.bump = ctx.bumps.config;

        let metas = extra_account_metas()?;
        let size = ExtraAccountMetaList::size_of(metas.len())
            .map_err(|_| error!(AllowlistError::ExtraMetasInit))?;
        let lamports = Rent::get()?.minimum_balance(size);

        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[
            EXTRA_METAS_SEED,
            mint_key.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ];
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
            size as u64,
            &crate::ID,
        )?;

        let info = ctx.accounts.extra_account_meta_list.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)
            .map_err(|_| error!(AllowlistError::ExtraMetasInit))?;
        Ok(())
    }

    /// Admin-only: allowlist `wallet` (creates or re-activates its AllowEntry).
    pub fn add_allow(ctx: Context<AddAllow>, wallet: Pubkey) -> Result<()> {
        let entry = &mut ctx.accounts.allow_entry;
        entry.mint = ctx.accounts.config.mint;
        entry.wallet = wallet;
        entry.active = true;
        entry.bump = ctx.bumps.allow_entry;
        Ok(())
    }

    /// Admin-only: deactivate `wallet`. The account is kept (active = false) so it
    /// can be re-activated cheaply.
    pub fn remove_allow(ctx: Context<RemoveAllow>, _wallet: Pubkey) -> Result<()> {
        ctx.accounts.allow_entry.active = false;
        Ok(())
    }

    /// Admin-only: rotate the admin key.
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// SPL transfer-hook `Execute` (discriminator = sha256("spl-transfer-hook-interface:execute")[..8]).
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        // Must be called by Token-2022 during a transfer.
        {
            let src = ctx.accounts.source_token.to_account_info();
            let data = src.try_borrow_data()?;
            let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
            let ext = state
                .get_extension::<TransferHookAccount>()
                .map_err(|_| error!(AllowlistError::NotTransferring))?;
            require!(bool::from(ext.transferring), AllowlistError::NotTransferring);
        }

        let dest_owner = ctx.accounts.destination_token.owner;
        let mint = ctx.accounts.mint.key();
        let entry_info = &ctx.accounts.allow_entry;

        let (expected, _) = Pubkey::find_program_address(
            &[ALLOW_SEED, mint.as_ref(), dest_owner.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(entry_info.key(), expected, AllowlistError::NotEligible);
        require_keys_eq!(*entry_info.owner, crate::ID, AllowlistError::NotEligible);

        let data = entry_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let entry = AllowEntry::try_deserialize(&mut slice)
            .map_err(|_| error!(AllowlistError::NotEligible))?;
        require!(
            entry.active && entry.mint == mint && entry.wallet == dest_owner,
            AllowlistError::NotEligible
        );
        Ok(())
    }
}

/// The single extra account required by `execute`: AllowEntry of the destination owner.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: ALLOW_SEED.to_vec(),
            },
            Seed::AccountKey { index: 1 }, // mint
            Seed::AccountData {
                account_index: 2, // destination token account
                data_index: 32,   // owner field
                length: 32,
            },
        ],
        false,
        false,
    )
    .map_err(|_| error!(AllowlistError::ExtraMetasInit))?])
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: created and initialized in the handler (TLV ExtraAccountMetaList).
    #[account(mut, seeds = [EXTRA_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AddAllow<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
        has_one = admin @ AllowlistError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + AllowEntry::INIT_SPACE,
        seeds = [ALLOW_SEED, config.mint.as_ref(), wallet.as_ref()],
        bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RemoveAllow<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
        has_one = admin @ AllowlistError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [ALLOW_SEED, config.mint.as_ref(), wallet.as_ref()],
        bump = allow_entry.bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
        has_one = admin @ AllowlistError::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

/// Account order fixed by the SPL transfer-hook interface.
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source owner / delegate, validated by Token-2022.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validation account PDA.
    #[account(seeds = [EXTRA_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: AllowEntry PDA of the destination owner; may be uninitialized
    /// (then the transfer is rejected with NotEligible). Validated in handler.
    pub allow_entry: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub mint: Pubkey,
    pub admin: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AllowEntry {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub active: bool,
    pub bump: u8,
}

#[error_code]
pub enum AllowlistError {
    #[msg("Destination wallet is not eligible to hold this token")]
    NotEligible,
    #[msg("Only the allowlist admin can do this")]
    Unauthorized,
    #[msg("Hook was not invoked during a Token-2022 transfer")]
    NotTransferring,
    #[msg("Failed to initialize extra account meta list")]
    ExtraMetasInit,
}
