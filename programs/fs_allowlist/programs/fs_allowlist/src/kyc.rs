//! Pure logic for the ZK-KYC gate (no Anchor types, natively testable).
//!
//! Proof system: Rarimo `queryIdentity` (circom, Groth16 / BN254, 23 public signals; the vkey in
//! `vk.rs` is the one shipped inside the RariMe app). Public signal layout (index -> meaning):
//!   0 nullifier            1 birthDate*     2 expirationDate*  3 name*      4 nameResidual*
//!   5 nationality*         6 citizenship    7 sex*             8 documentNumber*
//!   9 eventID             10 eventData     11 idStateRoot     12 selector  13 currentDate
//!  14 timestampLower     15 timestampUpper 16 identityCntLower 17 identityCntUpper
//!  18 birthDateLower     19 birthDateUpper 20 expirationLower  21 expirationUpper  22 citizenshipMask
//! (* = 0 unless revealed by the selector; we never reveal them.)
//!
//! The program never trusts a caller-supplied full signal vector: it rebuilds all 23 signals from
//! policy constants + a handful of checked arguments, so a proof only verifies if it was generated
//! for exactly this policy (selector, event id, wallet binding, age bound, ...).

use crate::vk::N_PUBLIC;

/// selector bits: 0 nullifier, 5 citizenship reveal, 15 `birthDate < birthDateUpperbound`.
pub const SELECTOR: u64 = (1 << 0) | (1 << 5) | (1 << 15);
/// Passport "no date" encoding: ASCII "000000".
pub const NO_DATE: u64 = 0x3030_3030_3030;
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Everything that varies per proof and is not fixed by policy.
pub struct Signals {
    pub nullifier: [u8; 32],
    pub citizenship: u32,
    pub id_state_root: [u8; 32],
    pub current_date: u64,
    pub timestamp_upper: u64,
    pub identity_counter_upper: u64,
    pub birth_date_upper: u64,
}

pub fn u64_be32(v: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[24..].copy_from_slice(&v.to_be_bytes());
    o
}

/// eventData binds the proof to a wallet: 31 bytes of sha256(wallet pubkey), as a 256-bit big-endian
/// integer (leading zero byte keeps it below the BN254 field modulus).
pub fn event_data_for(wallet_hash: &[u8; 32]) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[1..].copy_from_slice(&wallet_hash[..31]);
    o
}

/// Rebuild the 23 public signals the circuit must have produced.
pub fn build_public_signals(
    s: &Signals,
    event_id: &[u8; 32],
    event_data: &[u8; 32],
) -> [[u8; 32]; N_PUBLIC] {
    let mut p = [[0u8; 32]; N_PUBLIC];
    p[0] = s.nullifier;
    p[6] = u64_be32(s.citizenship as u64);
    p[9] = *event_id;
    p[10] = *event_data;
    p[11] = s.id_state_root;
    p[12] = u64_be32(SELECTOR);
    p[13] = u64_be32(s.current_date);
    p[15] = u64_be32(s.timestamp_upper);
    p[17] = u64_be32(s.identity_counter_upper);
    p[18] = u64_be32(NO_DATE);
    p[19] = u64_be32(s.birth_date_upper);
    p[20] = u64_be32(NO_DATE);
    p[21] = u64_be32(NO_DATE);
    // 1..5, 7, 8, 14, 16, 22 stay zero
    p
}

/// (year, month, day) of a unix timestamp (proleptic Gregorian, UTC). Howard Hinnant's algorithm.
pub fn civil_from_unix(ts: i64) -> (i64, u32, u32) {
    let z = ts.div_euclid(SECONDS_PER_DAY) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Passport date encoding: ASCII "YYMMDD" as a big-endian integer.
pub fn encode_yymmdd(y: i64, m: u32, d: u32) -> u64 {
    let s = [
        b'0' + ((y.rem_euclid(100) / 10) as u8),
        b'0' + ((y.rem_euclid(10)) as u8),
        b'0' + (m / 10) as u8,
        b'0' + (m % 10) as u8,
        b'0' + (d / 10) as u8,
        b'0' + (d % 10) as u8,
    ];
    s.iter().fold(0u64, |a, b| (a << 8) | *b as u64)
}

/// Encoded date of `ts` shifted by `days` days.
pub fn encoded_date(ts: i64, days: i64) -> u64 {
    let (y, m, d) = civil_from_unix(ts + days * SECONDS_PER_DAY);
    encode_yymmdd(y, m, d)
}

/// Latest birth date (exclusive) that satisfies "older than `min_age` years" at `ts`, as a full
/// (year, month, day). Feb 29 maps to Feb 28 when the target year is not a leap year (stricter).
pub fn age_cutoff(ts: i64, min_age: u8) -> (i64, u32, u32) {
    let (y, m, mut d) = civil_from_unix(ts);
    let ty = y - min_age as i64;
    if m == 2 && d == 29 && !is_leap(ty) {
        d = 28;
    }
    (ty, m, d)
}

/// (yy, mm, dd) of an ASCII "YYMMDD" integer, or None if any byte is not a digit.
pub fn decode_yymmdd(v: u64) -> Option<(u32, u32, u32)> {
    if v >> 48 != 0 {
        return None;
    }
    let mut dg = [0u32; 6];
    for (i, slot) in dg.iter_mut().enumerate() {
        let b = ((v >> (8 * (5 - i))) & 0xff) as u8;
        if !b.is_ascii_digit() {
            return None;
        }
        *slot = (b - b'0') as u32;
    }
    Some((dg[0] * 10 + dg[1], dg[2] * 10 + dg[3], dg[4] * 10 + dg[5]))
}

/// Same century rule as the circuit (`EncodedDateIsLessNormalized`): an encoded date that is
/// smaller than `currentDate` (as a string) is 20xx, otherwise 19xx.
pub fn normalize_yymmdd(encoded: u64, current: u64) -> Option<(i64, u32, u32)> {
    let (yy, m, d) = decode_yymmdd(encoded)?;
    let century = if encoded < current { 2000 } else { 1900 };
    Some((century + yy as i64, m, d))
}

/// True if the proven bound `birthDate < ub` implies age > `min_age` at `now`.
pub fn birth_bound_ok(ub: u64, current: u64, now: i64, min_age: u8) -> bool {
    match normalize_yymmdd(ub, current) {
        Some(n) => n <= age_cutoff(now, min_age),
        None => false,
    }
}

/// ISO-3166 alpha-3 as ASCII big-endian integer, e.g. "RUS" -> 0x525553.
pub const fn country(c: &[u8; 3]) -> u32 {
    ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | c[2] as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-09-25 12:00:00 UTC
    const NOW: i64 = 1_790_337_600;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_unix(0), (1970, 1, 1));
        assert_eq!(civil_from_unix(NOW), (2026, 9, 25));
        assert_eq!(civil_from_unix(951_782_400), (2000, 2, 29)); // leap day
        assert_eq!(civil_from_unix(-1), (1969, 12, 31));
    }

    #[test]
    fn encodes_like_the_passport() {
        assert_eq!(encode_yymmdd(2008, 9, 25), 0x3038_3039_3235); // "080925"
        assert_eq!(encoded_date(NOW, 0), 0x3236_3039_3235); // "260925"
        assert_eq!(encoded_date(NOW, -1), 0x3236_3039_3234);
        assert_eq!(encoded_date(NOW, 1), 0x3236_3039_3236);
    }

    #[test]
    fn age_cutoff_18() {
        assert_eq!(age_cutoff(NOW, 18), (2008, 9, 25)); // born strictly before 2008-09-25
        assert_eq!(age_cutoff(NOW, 21), (2005, 9, 25));
        // 2028-02-29 -> 2010-02-28 (2010 not a leap year)
        assert_eq!(age_cutoff(1_835_395_200, 18), (2010, 2, 28));
    }

    const CUR: u64 = 0x3236_3039_3235; // "260925"
    const A: fn(&str) -> u64 = |s| s.bytes().fold(0u64, |a, b| (a << 8) | b as u64);

    #[test]
    fn century_rule_matches_the_circuit() {
        assert_eq!(normalize_yymmdd(A("080925"), CUR), Some((2008, 9, 25)));
        assert_eq!(normalize_yymmdd(A("960925"), CUR), Some((1996, 9, 25)));
        assert_eq!(normalize_yymmdd(A("260925"), CUR), Some((1926, 9, 25))); // not < current
        assert_eq!(normalize_yymmdd(A("260924"), CUR), Some((2026, 9, 24)));
        assert_eq!(normalize_yymmdd(A("000000"), CUR), Some((2000, 0, 0)));
        assert_eq!(normalize_yymmdd(0x3038_3039_323a, CUR), None); // non-digit
        assert_eq!(normalize_yymmdd(0x01_3038_3039_3235, CUR), None); // >6 bytes
    }

    #[test]
    fn age_bound_18() {
        let ok = |ub: &str, min| birth_bound_ok(A(ub), CUR, NOW, min);
        assert!(ok("080925", 18)); // exactly the cutoff
        assert!(!ok("080926", 18)); // 17y364d
        assert!(!ok("100101", 18));
        assert!(ok("010101", 18)); // stricter bound is fine
        assert!(ok("990101", 18)); // 1999 < 2008
        assert!(!ok("081399", 18)); // month 13 loosens within 2008
        assert!(ok("071399", 18)); // still 2007
    }

    #[test]
    fn age_bound_across_the_century() {
        // regression: numeric YYMMDD compare treated "08…" < "96…" and let 2008 pass a 30+ policy
        let ok = |ub: &str, min| birth_bound_ok(A(ub), CUR, NOW, min);
        assert!(!ok("080925", 30));
        assert!(ok("960925", 30)); // 1996-09-25 == cutoff
        assert!(!ok("960926", 30));
        assert!(ok("950101", 30));
        assert!(!ok("000000", 30)); // "000000" is year 2000: looser than the 1996 cutoff
        assert!(ok("000000", 18)); // ...but stricter than the 2008 cutoff
    }

    #[test]
    fn signals_layout() {
        let s = Signals {
            nullifier: [7; 32],
            citizenship: country(b"UKR"),
            id_state_root: [9; 32],
            current_date: encoded_date(NOW, 0),
            timestamp_upper: 5,
            identity_counter_upper: 1,
            birth_date_upper: A("080925"),
        };
        let p = build_public_signals(&s, &[1; 32], &[2; 32]);
        assert_eq!(p.len(), 23);
        assert_eq!(p[6], u64_be32(5_589_842)); // "UKR"
        assert_eq!(p[12], u64_be32(32_801));
        assert_eq!(p[18], u64_be32(0x3030_3030_3030));
        assert_eq!(p[1], [0; 32]);
        assert_eq!(p[22], [0; 32]);
    }
}
