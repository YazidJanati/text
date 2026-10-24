use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce,
};
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 9] = b"TEXTLOCK\x01";
const HEADER: usize = 9 + 16 + 24;
#[derive(Clone)]
pub struct Secret {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
}
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Could not obtain secure randomness.".to_string())?;
    Ok(bytes)
}
fn derive(password: &str, salt: [u8; 16]) -> Result<Secret, String> {
    if password.is_empty() || password.len() > 1024 {
        return Err("Enter a password between 1 and 1024 bytes.".into());
    }
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, key.as_mut())
        .map_err(|e| e.to_string())?;
    Ok(Secret { key, salt })
}
pub fn seal(content: &str, secret: &Secret) -> Result<Vec<u8>, String> {
    let nonce = random::<24>()?;
    let mut output = Vec::with_capacity(HEADER + content.len() + 16);
    output.extend_from_slice(MAGIC);
    output.extend_from_slice(&secret.salt);
    output.extend_from_slice(&nonce);
    let cipher =
        XChaCha20Poly1305::new_from_slice(secret.key.as_ref()).map_err(|e| e.to_string())?;
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: content.as_bytes(),
                aad: &output,
            },
        )
        .map_err(|_| "Could not encrypt this note.".to_string())?;
    output.extend_from_slice(&encrypted);
    Ok(output)
}
pub fn protect(content: &str, password: &str) -> Result<(Vec<u8>, Secret), String> {
    let secret = derive(password, random::<16>()?)?;
    let disk = seal(content, &secret)?;
    Ok((disk, secret))
}
pub fn unlock(disk: &[u8], password: &str) -> Result<(Zeroizing<String>, Secret), String> {
    if disk.len() < HEADER + 16 || !disk.starts_with(MAGIC) {
        return Err("This protected note is damaged or uses an unsupported format.".into());
    }
    let salt: [u8; 16] = disk[9..25].try_into().map_err(|_| "Invalid salt.")?;
    let secret = derive(password, salt)?;
    let content = open(disk, &secret)?;
    Ok((content, secret))
}
// Private folder notes share the folder key, but every write has a fresh nonce.
pub fn open(disk: &[u8], secret: &Secret) -> Result<Zeroizing<String>, String> {
    if disk.len() < HEADER + 16 || !disk.starts_with(MAGIC) || disk[9..25] != secret.salt {
        return Err("This private note is damaged or uses a different key.".into());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(secret.key.as_ref()).map_err(|e| e.to_string())?;
    let bytes = Zeroizing::new(cipher.decrypt(
        XNonce::from_slice(&disk[25..HEADER]),
        Payload { msg: &disk[HEADER..], aad: &disk[..HEADER] },
    ).map_err(|_| "Incorrect password, or this note has been damaged.".to_string())?);
    Ok(Zeroizing::new(std::str::from_utf8(&bytes).map_err(|_| "Invalid note content.")?.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_randomized_ciphertext() {
        let text = "# Private\n\n$E=mc^2$\n";
        let (disk, secret) = protect(text, "correct horse").unwrap();
        assert!(!disk.windows(text.len()).any(|part| part == text.as_bytes()));
        assert_eq!(unlock(&disk, "correct horse").unwrap().0.as_str(), text);
        assert_ne!(disk, seal(text, &secret).unwrap());
    }
    #[test]
    fn wrong_password_and_tampering_fail() {
        let (mut disk, _) = protect("Private content", "right").unwrap();
        assert!(unlock(&disk, "wrong").is_err());
        let last = disk.len() - 1;
        disk[last] ^= 1;
        assert!(unlock(&disk, "right").is_err());
        assert!(unlock(&disk[..10], "right").is_err());
    }
}
