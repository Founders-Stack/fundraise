"use client";

// DEV ONLY (NEXT_PUBLIC_DEV_BURNER_WALLET=1): an in-browser keypair wallet, so the onboarding and
// trade flows can be exercised locally (and in headless browsers) without Phantom. The secret key
// sits in localStorage; disconnecting forgets it, so the next connect is a brand-new wallet
// (handy for the "Carol isn't onboarded" beat). Never enable it for real funds.
import {
  BaseMessageSignerWalletAdapter,
  WalletNotConnectedError,
  WalletReadyState,
  isVersionedTransaction,
  type SupportedTransactionVersions,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { Keypair, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const DevBurnerWalletName = "Dev burner (local only)" as WalletName<"Dev burner (local only)">;
const STORAGE_KEY = "fs-dev-burner";
const ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#b45309"/><path d="M12 5c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-7z" fill="#fff"/></svg>',
  );

export function devBurnerEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEV_BURNER_WALLET === "1";
}

export class DevBurnerWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = DevBurnerWalletName;
  url = "https://github.com/anza-xyz/wallet-adapter";
  icon = ICON;
  supportedTransactionVersions: SupportedTransactionVersions = new Set(["legacy", 0] as const);

  private keypair: Keypair | null = null;

  get connecting() {
    return false;
  }
  get publicKey() {
    return this.keypair?.publicKey ?? null;
  }
  get readyState() {
    return typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;
  }

  async connect(): Promise<void> {
    let kp: Keypair | null = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) kp = Keypair.fromSecretKey(bs58.decode(stored));
    } catch {
      kp = null;
    }
    if (!kp) {
      kp = Keypair.generate();
      try {
        localStorage.setItem(STORAGE_KEY, bs58.encode(kp.secretKey));
      } catch {
        /* storage unavailable: the wallet lasts for this page only */
      }
    }
    this.keypair = kp;
    this.emit("connect", kp.publicKey);
  }

  async disconnect(): Promise<void> {
    this.keypair = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this.keypair) throw new WalletNotConnectedError();
    if (isVersionedTransaction(tx)) tx.sign([this.keypair]);
    else tx.partialSign(this.keypair);
    return tx;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.keypair) throw new WalletNotConnectedError();
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
}
