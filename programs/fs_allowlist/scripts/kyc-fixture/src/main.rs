//! Generates a Groth16 (BN254) fixture with N public inputs in the byte layout that
//! `groth16-solana` / Solana alt_bn128 syscalls expect, and verifies it natively.
//! Verification cost depends only on the number of public inputs, so this stands in for
//! Rarimo `queryIdentity` (23 public signals) until the real zkey is available.
use ark_bn254::{Bn254, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField, UniformRand};
use ark_groth16::Groth16;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

const N: usize = 23;

#[derive(Clone)]
struct C {
    x: [Option<Fr>; N],
}

impl ConstraintSynthesizer<Fr> for C {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::fp::FpVar};
        let mut prev: Option<FpVar<Fr>> = None;
        for i in 0..N {
            let v = FpVar::new_input(cs.clone(), || self.x[i].ok_or(SynthesisError::AssignmentMissing))?;
            // constrain each input non-trivially: w_i = x_i * x_i (private), chain equality
            let w = FpVar::new_witness(cs.clone(), || {
                self.x[i].map(|x| x * x).ok_or(SynthesisError::AssignmentMissing)
            })?;
            (&v * &v).enforce_equal(&w)?;
            prev = Some(w);
        }
        let _ = prev;
        Ok(())
    }
}

fn be32(f: impl PrimeField) -> [u8; 32] {
    let mut b = [0u8; 32];
    let v = f.into_bigint().to_bytes_be();
    b[32 - v.len()..].copy_from_slice(&v);
    b
}
fn g1(p: G1Affine) -> [u8; 64] {
    let (x, y) = p.xy().unwrap();
    let mut o = [0u8; 64];
    o[..32].copy_from_slice(&be32(x));
    o[32..].copy_from_slice(&be32(y));
    o
}
fn g2(p: G2Affine) -> [u8; 128] {
    let (x, y) = p.xy().unwrap();
    let mut o = [0u8; 128];
    // alt_bn128 G2 encoding: x.c1 || x.c0 || y.c1 || y.c0
    o[..32].copy_from_slice(&be32(x.c1));
    o[32..64].copy_from_slice(&be32(x.c0));
    o[64..96].copy_from_slice(&be32(y.c1));
    o[96..].copy_from_slice(&be32(y.c0));
    o
}

fn main() {
    let mut rng = StdRng::seed_from_u64(7);
    let xs: Vec<Fr> = (0..N).map(|_| Fr::rand(&mut rng)).collect();
    let mut arr = [None; N];
    for i in 0..N { arr[i] = Some(xs[i]); }
    let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(C { x: [None; N] }, &mut rng).unwrap();
    let proof = Groth16::<Bn254>::prove(&pk, C { x: arr }, &mut rng).unwrap();
    assert!(Groth16::<Bn254>::verify(&vk, &xs, &proof).unwrap());

    let a_neg = g1(-proof.a);
    let b = g2(proof.b);
    let c = g1(proof.c);
    let ic: Vec<[u8; 64]> = vk.gamma_abc_g1.iter().map(|p| g1(*p)).collect();
    let pubs: Vec<[u8; 32]> = xs.iter().map(|x| be32(*x)).collect();

    // native check with groth16-solana
    let vk_s = Groth16Verifyingkey {
        nr_pubinputs: N,
        vk_alpha_g1: g1(vk.alpha_g1),
        vk_beta_g2: g2(vk.beta_g2),
        vk_gamme_g2: g2(vk.gamma_g2),
        vk_delta_g2: g2(vk.delta_g2),
        vk_ic: &ic,
    };
    let pubs_arr: [[u8; 32]; N] = pubs.clone().try_into().unwrap();
    let mut v = Groth16Verifier::new(&a_neg, &b, &c, &pubs_arr, &vk_s).unwrap();
    v.verify().expect("groth16-solana native verify failed");
    eprintln!("native groth16-solana verify OK ({} public inputs)", N);

    let hex = |b: &[u8]| b.iter().map(|x| format!("{:02x}", x)).collect::<String>();
    let out = serde_json::json!({
        "nPublic": N,
        "vk": {
            "alpha_g1": hex(&g1(vk.alpha_g1)),
            "beta_g2": hex(&g2(vk.beta_g2)),
            "gamma_g2": hex(&g2(vk.gamma_g2)),
            "delta_g2": hex(&g2(vk.delta_g2)),
            "ic": ic.iter().map(|x| hex(x)).collect::<Vec<_>>(),
        },
        "proof": { "a_neg": hex(&a_neg), "b": hex(&b), "c": hex(&c) },
        "public": pubs.iter().map(|x| hex(x)).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
