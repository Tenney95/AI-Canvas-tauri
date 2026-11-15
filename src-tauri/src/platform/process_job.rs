//! Windows Job Object ownership only; callers retain process policy and reaping.
use std::{os::windows::io::AsRawHandle, process::Child};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    },
};

pub(crate) enum AttachError {
    Create,
    Configure,
    Assign,
}

pub(crate) struct ProcessJob(HANDLE);

impl ProcessJob {
    pub(crate) fn attach(child: &Child) -> Result<Self, AttachError> {
        let job =
            Self(unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|_| AttachError::Create)?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // The owned job and stack limit structure stay valid for these synchronous calls.
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|_| AttachError::Configure)?;
        unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }
            .map_err(|_| AttachError::Assign)?;
        Ok(job)
    }

    pub(crate) fn terminate(&self) {
        unsafe {
            let _ = TerminateJobObject(self.0, 1223);
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
