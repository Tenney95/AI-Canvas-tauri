//! Read the same-user WSAGENT credential from the Windows profile.

use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Path, Prefix},
};
use windows::Win32::{
    Foundation::HANDLE,
    Security::{Authorization::SE_FILE_OBJECT, CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE},
    Storage::FileSystem::{
        GetFileInformationByHandle, GetFileType, BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_TYPE_DISK, READ_CONTROL,
    },
};

use super::{
    decode_pairing_discovery, invalid_pairing_discovery, pairing_discovery_unavailable,
    PairingDiscovery, SharedResult, PAIRING_DISCOVERY_LIMIT, RENDEZVOUS_DIRECTORY,
};
use crate::plugin_delivery::windows_security::{verify_private_handle, CurrentUser};

fn open_pinned(path: &Path, directory: bool, access: u32) -> SharedResult<File> {
    let share = if directory {
        FILE_SHARE_READ | FILE_SHARE_WRITE
    } else {
        FILE_SHARE_READ
    };
    let file = OpenOptions::new()
        .access_mode(access)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
        // No DELETE sharing: checked ancestors cannot be swapped during the read.
        .share_mode(share.0)
        .open(path)
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => pairing_discovery_unavailable(),
            _ => invalid_pairing_discovery(),
        })?;
    let handle = HANDLE(file.as_raw_handle());
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns the handle and Windows receives a correctly sized buffer.
    unsafe { GetFileInformationByHandle(handle, &mut info) }
        .map_err(|_| invalid_pairing_discovery())?;
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0) != directory
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(invalid_pairing_discovery());
    }
    Ok(file)
}

pub(super) fn read_pairing_discovery(base: &Path) -> SharedResult<PairingDiscovery> {
    if !base.is_absolute()
        || !matches!(
            base.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
    {
        return Err(invalid_pairing_discovery());
    }
    let mut ancestors: Vec<_> = base.ancestors().filter(|path| path.is_absolute()).collect();
    ancestors.reverse();
    let _base_pins = ancestors
        .into_iter()
        .map(|path| open_pinned(path, true, FILE_READ_ATTRIBUTES.0))
        .collect::<SharedResult<Vec<_>>>()?;
    let directory = base.join(RENDEZVOUS_DIRECTORY);
    let directory_pin = open_pinned(&directory, true, FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0)?;
    let user = CurrentUser::read().map_err(|_| invalid_pairing_discovery())?;
    verify_private_handle(
        HANDLE(directory_pin.as_raw_handle()),
        SE_FILE_OBJECT,
        &user,
        (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8,
        FILE_ALL_ACCESS.0,
    )
    .map_err(|_| invalid_pairing_discovery())?;
    let descriptor = open_pinned(
        &directory.join("wsagent-v1.json"),
        false,
        FILE_GENERIC_READ.0,
    )?;
    verify_private_handle(
        HANDLE(descriptor.as_raw_handle()),
        SE_FILE_OBJECT,
        &user,
        0,
        FILE_ALL_ACCESS.0,
    )
    .map_err(|_| invalid_pairing_discovery())?;
    let length = descriptor
        .metadata()
        .map_err(|_| invalid_pairing_discovery())?
        .len();
    if !(1..=PAIRING_DISCOVERY_LIMIT).contains(&length) {
        return Err(invalid_pairing_discovery());
    }
    let mut bytes = Vec::new();
    descriptor
        .take(PAIRING_DISCOVERY_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid_pairing_discovery())?;
    if bytes.len() as u64 != length {
        return Err(invalid_pairing_discovery());
    }
    decode_pairing_discovery(&bytes)
}
