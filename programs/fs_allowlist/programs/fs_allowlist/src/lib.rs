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
//! Meteora DBC integration (verified against MeteoraAg/dynamic-bonding-curve source):
//! - `initialize_virtual_pool_with_token2022_transfer_hook` creates the base mint with
//!   `TransferHook { authority: pool_authority, program_id: <this program> }` and MINTS the
//!   whole supply into the base vault (MintTo does not invoke the hook). DBC never CPIs into
//!   this program during pool creation, so `initialize` only needs the mint to exist and can run
//!   as a later instruction of the SAME transaction. The chain lib (apps/web/lib/chain/devnet/dbc.ts
//!   `createHookPool`) sends [DBC create pool, fs_allowlist.initialize, add_allow(pool authority)]
//!   atomically (H12): the mint never exists on-chain without its Config. Only the DBC partner
//!   `createConfig` goes in a preceding tx, because config + pool + hook init in one legacy tx is
//!   1380 bytes (> 1232); pool + hook init is ~1044 bytes.
//! - Swaps (`swap2_with_transfer_hook`) forward the extra accounts to Token-2022 through
//!   `add_extra_accounts_for_execute_cpi`, which resolves our AccountData seed on-chain.
//!   NOTE: the DBC SDK's client-side resolver passes PublicKey.default as the destination,
//!   so it can't resolve an AccountData seed; clients must pass
//!   [AllowEntry(dest owner), this program, ExtraAccountMetaList] themselves.
//! - At curve completion DBC revokes the transfer hook (program id -> None, authority -> None)
//!   so the pool can migrate to DAMM v2. Allowlist enforcement therefore ends at graduation.
//!
//! Operational note: after a Meteora DBC pool is created, the admin MUST call
//! `add_allow(pool_authority)` (the DBC pool-authority PDA owns the base vault),
//! otherwise sells into the pool fail with `NotEligible`. No special-casing here.
//!
//! Hardening (H12): `initialize` must be signed by `FS_AUTHORITY` (compile-time constant) so
//! nobody can front-run the Config/ExtraAccountMetaList creation for a freshly created mint and
//! take over its allowlist admin. Defense in depth with the atomic bundling above.
//!
//! Cluster: the default build uses the devnet authority. For mainnet build with
//! `FS_AUTHORITY_MAINNET=<pubkey> anchor build -- --features mainnet`; the pubkey is parsed at
//! compile time, so a missing/invalid value fails the build instead of shipping a wrong key.

//! ZK-KYC gate (Rarimo `queryIdentity` Groth16 proof, verified on-chain; see `kyc.rs`):
//! `submit_kyc_proof` verifies the proof and writes a per-wallet `KycAttestation` (age > min_age,
//! citizenship not blocked, bound to the wallet, one wallet per passport identity via a nullifier
//! PDA). Issuers opt a mint in with `enable_kyc`; then any wallet holding a valid attestation can
//! `add_allow_kyc` itself. The transfer hook (`execute`) is unchanged: it still only reads
//! `AllowEntry`. Attestation expiry / newly blocked countries are enforced by the permissionless
//! `revoke_kyc_allow` crank, not inside the hook.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use groth16_solana::groth16::Groth16Verifier;
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

mod kyc;
mod vk;

declare_id!("3gfXWxgHN8tjJzxXGeAEiZWaixDe7ZMxXQGnpvHkQZu7");

pub const CONFIG_SEED: &[u8] = b"config";
pub const ALLOW_SEED: &[u8] = b"allow";
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";
pub const KYC_CONFIG_SEED: &[u8] = b"kyc-config";
pub const KYC_POLICY_SEED: &[u8] = b"kyc-policy";
pub const KYC_SEED: &[u8] = b"kyc";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
pub const MAX_BLOCKED: usize = 64;
pub const MAX_ROOTS: usize = 8;
/// Accepted clock skew (days) between the proof's `currentDate` and the cluster clock.
pub const DATE_SKEW_DAYS: i64 = 1;

/// Founder Stack authority (devnet: keys/fs-authority.json). Only this key may initialize
/// a mint's allowlist Config + ExtraAccountMetaList.
#[cfg(not(feature = "mainnet"))]
pub const FS_AUTHORITY: Pubkey = pubkey!("947L5j9d55jFGNyCSwguX8PHTDb5VNyidvRhy7UPDtUB");

/// Mainnet Founder Stack authority, injected at build time (see module docs).
#[cfg(feature = "mainnet")]
pub const FS_AUTHORITY: Pubkey = Pubkey::from_str_const(env!("FS_AUTHORITY_MAINNET"));

#[program]
pub mod fs_allowlist {
    use super::*;

    /// Creates the Config PDA and the ExtraAccountMetaList for `mint`.
    /// Must be signed by `FS_AUTHORITY`.
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

    // ------------------------------------------------------------------------------------
    // ZK-KYC (Rarimo queryIdentity Groth16)
    // ------------------------------------------------------------------------------------

    /// Creates the global KYC policy. Signed by `FS_AUTHORITY` (front-run protection, like `initialize`).
    /// `event_id` is the 254-bit circuit event id (big-endian) every proof must be generated for.
    pub fn init_kyc_config(
        ctx: Context<InitKycConfig>,
        admin: Pubkey,
        event_id: [u8; 32],
        min_age: u8,
        ttl_secs: i64,
        blocked: Vec<u32>,
    ) -> Result<()> {
        require!(blocked.len() <= MAX_BLOCKED, AllowlistError::TooMany);
        require!(ttl_secs > 0, AllowlistError::BadPolicy);
        let c = &mut ctx.accounts.kyc_config;
        c.admin = admin;
        c.event_id = event_id;
        c.min_age = min_age;
        c.ttl_secs = ttl_secs;
        c.blocked = blocked;
        c.roots = Vec::new();
        c.bump = ctx.bumps.kyc_config;
        Ok(())
    }

    /// Admin: replace min age, attestation TTL and the blocked-citizenship list (alpha-3 as u32).
    pub fn set_kyc_policy(
        ctx: Context<KycAdmin>,
        min_age: u8,
        ttl_secs: i64,
        blocked: Vec<u32>,
    ) -> Result<()> {
        require!(blocked.len() <= MAX_BLOCKED, AllowlistError::TooMany);
        require!(ttl_secs > 0, AllowlistError::BadPolicy);
        let c = &mut ctx.accounts.kyc_config;
        c.min_age = min_age;
        c.ttl_secs = ttl_secs;
        c.blocked = blocked;
        Ok(())
    }

    /// Admin (root relayer): accept a Rarimo identity-state root. Keeps the newest `MAX_ROOTS`.
    pub fn push_kyc_root(ctx: Context<KycAdmin>, root: [u8; 32]) -> Result<()> {
        let c = &mut ctx.accounts.kyc_config;
        if !c.roots.contains(&root) {
            if c.roots.len() == MAX_ROOTS {
                c.roots.remove(0);
            }
            c.roots.push(root);
        }
        Ok(())
    }

    /// Mint admin: require/allow KYC self-onboarding for this mint.
    pub fn enable_kyc(ctx: Context<EnableKyc>) -> Result<()> {
        ctx.accounts.kyc_policy.mint = ctx.accounts.config.mint;
        ctx.accounts.kyc_policy.bump = ctx.bumps.kyc_policy;
        Ok(())
    }

    /// Verify a Rarimo query proof for the signer and record a `KycAttestation`.
    /// `proof_a` must be the NEGATED G1 point (groth16-solana convention).
    #[allow(clippy::too_many_arguments)]
    pub fn submit_kyc_proof(
        ctx: Context<SubmitKycProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        nullifier: [u8; 32],
        citizenship: u32,
        id_state_root: [u8; 32],
        current_date: u64,
        timestamp_upper: u64,
        identity_counter_upper: u64,
        birth_date_upper: u64,
    ) -> Result<()> {
        let cfg = &ctx.accounts.kyc_config;
        let wallet = ctx.accounts.wallet.key();
        let now = Clock::get()?.unix_timestamp;

        // --- policy checks (cheap, before the pairing) ---
        require!(nullifier != [0u8; 32], AllowlistError::BadProof);
        require!(cfg.roots.contains(&id_state_root), AllowlistError::UnknownRoot);
        // citizenship must be revealed (3 non-zero bytes) and not blocked
        require!(citizenship > 0xFF && citizenship <= 0xFF_FFFF, AllowlistError::BadProof);
        require!(!cfg.blocked.contains(&citizenship), AllowlistError::CountryBlocked);
        // proof's date must match the cluster clock (it disambiguates the century in the circuit)
        let date_ok = (-DATE_SKEW_DAYS..=DATE_SKEW_DAYS)
            .any(|d| kyc::encoded_date(now, d) == current_date);
        require!(date_ok, AllowlistError::StaleProof);
        // age: the circuit proves birthDate < birth_date_upper; that bound must be at least as
        // strict as "today - min_age years".
        require!(kyc::decode_yymmdd(birth_date_upper).is_some(), AllowlistError::BadProof);
        require!(
            kyc::birth_bound_ok(birth_date_upper, current_date, now, cfg.min_age),
            AllowlistError::AgeBoundTooLax
        );

        // --- rebuild every public signal from policy + wallet, then verify the pairing ---
        let wallet_hash = solana_sha256_hasher::hash(wallet.as_ref()).to_bytes();
        let event_data = kyc::event_data_for(&wallet_hash);
        let public = kyc::build_public_signals(
            &kyc::Signals {
                nullifier,
                citizenship,
                id_state_root,
                current_date,
                timestamp_upper,
                identity_counter_upper,
                birth_date_upper,
            },
            &cfg.event_id,
            &event_data,
        );
        let mut v = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &public, &vk::VERIFYING_KEY)
            .map_err(|_| error!(AllowlistError::BadProof))?;
        v.verify().map_err(|_| error!(AllowlistError::InvalidProof))?;

        // --- one wallet per passport identity ---
        let nf = &mut ctx.accounts.nullifier_record;
        if nf.wallet != Pubkey::default() {
            require_keys_eq!(nf.wallet, wallet, AllowlistError::NullifierUsed);
        }
        nf.wallet = wallet;
        nf.bump = ctx.bumps.nullifier_record;

        let a = &mut ctx.accounts.attestation;
        a.wallet = wallet;
        a.nullifier = nullifier;
        a.citizenship = citizenship;
        a.issued_at = now;
        a.expires_at = now.checked_add(cfg.ttl_secs).ok_or(AllowlistError::BadPolicy)?;
        a.bump = ctx.bumps.attestation;
        Ok(())
    }

    /// Self-service: a wallet with a valid attestation activates its own `AllowEntry` for a
    /// KYC-enabled mint.
    pub fn add_allow_kyc(ctx: Context<AddAllowKyc>) -> Result<()> {
        let a = &ctx.accounts.attestation;
        require!(
            a.expires_at > Clock::get()?.unix_timestamp,
            AllowlistError::AttestationExpired
        );
        require!(
            !ctx.accounts.kyc_config.blocked.contains(&a.citizenship),
            AllowlistError::CountryBlocked
        );
        let entry = &mut ctx.accounts.allow_entry;
        entry.mint = ctx.accounts.kyc_policy.mint;
        entry.wallet = ctx.accounts.wallet.key();
        entry.active = true;
        entry.bump = ctx.bumps.allow_entry;
        Ok(())
    }

    /// Permissionless crank: deactivate the `AllowEntry` of a wallet whose attestation expired or
    /// whose citizenship has since been blocked. Only wallets that have an attestation can be
    /// revoked this way (admin-only allowlisted wallets are untouched).
    pub fn revoke_kyc_allow(ctx: Context<RevokeKycAllow>, _wallet: Pubkey) -> Result<()> {
        let a = &ctx.accounts.attestation;
        let expired = a.expires_at <= Clock::get()?.unix_timestamp;
        let blocked = ctx.accounts.kyc_config.blocked.contains(&a.citizenship);
        require!(expired || blocked, AllowlistError::StillValid);
        ctx.accounts.allow_entry.active = false;
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

#[derive(Accounts)]
pub struct InitKycConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = FS_AUTHORITY @ AllowlistError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + KycConfig::INIT_SPACE,
        seeds = [KYC_CONFIG_SEED],
        bump
    )]
    pub kyc_config: Account<'info, KycConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct KycAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [KYC_CONFIG_SEED],
        bump = kyc_config.bump,
        has_one = admin @ AllowlistError::Unauthorized
    )]
    pub kyc_config: Account<'info, KycConfig>,
}

#[derive(Accounts)]
pub struct EnableKyc<'info> {
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
        space = 8 + MintKycPolicy::INIT_SPACE,
        seeds = [KYC_POLICY_SEED, config.mint.as_ref()],
        bump
    )]
    pub kyc_policy: Account<'info, MintKycPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64], proof_b: [u8; 128], proof_c: [u8; 64], nullifier: [u8; 32]
)]
pub struct SubmitKycProof<'info> {
    /// The wallet the proof is bound to (eventData = hash of this key); pays rent.
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [KYC_CONFIG_SEED], bump = kyc_config.bump)]
    pub kyc_config: Account<'info, KycConfig>,
    #[account(
        init_if_needed,
        payer = wallet,
        space = 8 + KycAttestation::INIT_SPACE,
        seeds = [KYC_SEED, wallet.key().as_ref()],
        bump
    )]
    pub attestation: Account<'info, KycAttestation>,
    #[account(
        init_if_needed,
        payer = wallet,
        space = 8 + NullifierRecord::INIT_SPACE,
        seeds = [NULLIFIER_SEED, nullifier.as_ref()],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddAllowKyc<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [KYC_CONFIG_SEED], bump = kyc_config.bump)]
    pub kyc_config: Account<'info, KycConfig>,
    #[account(
        seeds = [KYC_POLICY_SEED, kyc_policy.mint.as_ref()],
        bump = kyc_policy.bump
    )]
    pub kyc_policy: Account<'info, MintKycPolicy>,
    #[account(
        seeds = [KYC_SEED, wallet.key().as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, KycAttestation>,
    #[account(
        init_if_needed,
        payer = wallet,
        space = 8 + AllowEntry::INIT_SPACE,
        seeds = [ALLOW_SEED, kyc_policy.mint.as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RevokeKycAllow<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [KYC_CONFIG_SEED], bump = kyc_config.bump)]
    pub kyc_config: Account<'info, KycConfig>,
    #[account(
        seeds = [KYC_POLICY_SEED, kyc_policy.mint.as_ref()],
        bump = kyc_policy.bump
    )]
    pub kyc_policy: Account<'info, MintKycPolicy>,
    #[account(
        seeds = [KYC_SEED, wallet.as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, KycAttestation>,
    #[account(
        mut,
        seeds = [ALLOW_SEED, kyc_policy.mint.as_ref(), wallet.as_ref()],
        bump = allow_entry.bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,
}

#[account]
#[derive(InitSpace)]
pub struct KycConfig {
    pub admin: Pubkey,
    /// Circuit event id every accepted proof must carry (big-endian, < BN254 field).
    pub event_id: [u8; 32],
    pub min_age: u8,
    pub ttl_secs: i64,
    /// Blocked citizenships, ISO alpha-3 packed as u32 (e.g. "RUS" = 0x525553).
    #[max_len(64)]
    pub blocked: Vec<u32>,
    /// Accepted Rarimo identity-state roots (newest last).
    #[max_len(8)]
    pub roots: Vec<[u8; 32]>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MintKycPolicy {
    pub mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct KycAttestation {
    pub wallet: Pubkey,
    pub nullifier: [u8; 32],
    pub citizenship: u32,
    pub issued_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NullifierRecord {
    pub wallet: Pubkey,
    pub bump: u8,
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
    #[account(address = FS_AUTHORITY @ AllowlistError::Unauthorized)]
    pub authority: Signer<'info>,
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
    #[msg("Malformed KYC proof input")]
    BadProof,
    #[msg("Groth16 proof is invalid")]
    InvalidProof,
    #[msg("Identity state root is not accepted")]
    UnknownRoot,
    #[msg("Citizenship is blocked")]
    CountryBlocked,
    #[msg("Proof date does not match the cluster clock")]
    StaleProof,
    #[msg("Proof age bound is looser than the required minimum age")]
    AgeBoundTooLax,
    #[msg("This passport identity is already bound to another wallet")]
    NullifierUsed,
    #[msg("KYC attestation expired")]
    AttestationExpired,
    #[msg("Attestation is still valid")]
    StillValid,
    #[msg("Too many entries")]
    TooMany,
    #[msg("Invalid policy")]
    BadPolicy,
}
