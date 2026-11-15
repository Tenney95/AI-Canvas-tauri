//! Only operating-system cryptographic randomness; callers retain their own formats and errors.

pub(crate) fn random_bytes<const N: usize>() -> Result<[u8; N], ()> {
    let mut bytes = [0_u8; N];
    #[cfg(windows)]
    {
        #[link(name = "advapi32")]
        unsafe extern "system" {
            #[link_name = "SystemFunction036"]
            fn rtl_gen_random(buffer: *mut std::ffi::c_void, length: u32) -> u8;
        }
        let length = u32::try_from(N).map_err(|_| ())?;
        if unsafe { rtl_gen_random(bytes.as_mut_ptr().cast(), length) } == 0 {
            return Err(());
        }
    }
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes))
            .map_err(|_| ())?;
    }
    #[cfg(not(any(windows, unix)))]
    return Err(());
    Ok(bytes)
}
