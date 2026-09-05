// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Pending payloads belong to a Webview instance, not an app or a reusable label.

use std::{
  collections::HashMap,
  io,
  sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
  },
};

// Preserve numeric wire IDs, but never wrap and reuse a previously issued ID.
static DATA_COUNTER: AtomicU32 = AtomicU32::new(0);

pub(crate) struct ChannelDataQueue<T>(Arc<Mutex<QueueState<T>>>);

struct QueueState<T> {
  closed: bool,
  data: HashMap<u32, T>,
}

impl<T> Default for ChannelDataQueue<T> {
  fn default() -> Self {
    Self(Arc::new(Mutex::new(QueueState {
      closed: false,
      data: HashMap::new(),
    })))
  }
}

impl<T> Clone for ChannelDataQueue<T> {
  fn clone(&self) -> Self {
    Self(self.0.clone())
  }
}

impl<T> ChannelDataQueue<T> {
  pub(crate) fn ensure_open(&self) -> io::Result<()> {
    let state = self
      .0
      .lock()
      .map_err(|_| io::Error::other("channel queue unavailable"))?;
    if state.closed {
      return Err(io::Error::new(
        io::ErrorKind::BrokenPipe,
        "channel webview closed",
      ));
    }
    Ok(())
  }

  fn insert(&self, data: T) -> io::Result<u32> {
    let mut state = self
      .0
      .lock()
      .map_err(|_| io::Error::other("channel queue unavailable"))?;
    if state.closed {
      return Err(io::Error::new(
        io::ErrorKind::BrokenPipe,
        "channel webview closed",
      ));
    }
    let id = DATA_COUNTER
      .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        value.checked_add(1)
      })
      .map_err(|_| io::Error::other("channel data identifiers exhausted"))?;
    state.data.insert(id, data);
    Ok(id)
  }

  /// Do not retain a payload if dispatching its fetch instruction fails.
  pub(crate) fn deliver<E: From<io::Error>>(
    &self,
    data: T,
    dispatch: impl FnOnce(u32) -> Result<(), E>,
  ) -> Result<(), E> {
    let id = self.insert(data)?;
    let result = dispatch(id);
    if result.is_err() {
      if let Ok(mut state) = self.0.lock() {
        state.data.remove(&id);
      }
    }
    result
  }

  pub(crate) fn take(&self, id: u32) -> Result<T, &'static str> {
    let mut state = self.0.lock().map_err(|_| "channel queue unavailable")?;
    if state.closed {
      return Err("channel webview closed");
    }
    state.data.remove(&id).ok_or("data not found")
  }

  /// Shared with all clones of this Webview, including outstanding senders.
  pub(crate) fn close(&self) {
    let mut state = self
      .0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.closed = true;
    state.data.clear();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn enqueue<T>(queue: &ChannelDataQueue<T>, data: T) -> u32 {
    let mut id = None;
    queue
      .deliver::<io::Error>(data, |value| {
        id = Some(value);
        Ok(())
      })
      .unwrap();
    id.unwrap()
  }

  #[test]
  fn other_webview_cannot_consume_data() {
    let owner = ChannelDataQueue::default();
    let other = ChannelDataQueue::<Vec<u8>>::default();
    let id = enqueue(&owner, vec![42; 8192]);
    assert_eq!(other.take(id), Err("data not found"));
    assert_eq!(owner.clone().take(id).unwrap(), vec![42; 8192]);
    assert_eq!(owner.take(id), Err("data not found"));
  }

  #[test]
  fn close_revokes_pending_data_and_late_senders() {
    let owner = ChannelDataQueue::default();
    let sender = owner.clone();
    let id = enqueue(&owner, "pending");
    owner.close();
    assert!(sender.ensure_open().is_err());
    assert_eq!(sender.take(id), Err("channel webview closed"));
    assert!(sender
      .deliver::<io::Error>("late", |_| panic!("must not dispatch"))
      .is_err());
    assert!(owner.0.lock().unwrap().data.is_empty());
  }

  #[test]
  fn new_instance_never_inherits_old_queue() {
    let old = ChannelDataQueue::default();
    let id = enqueue(&old, "old");
    old.close();
    let reopened = ChannelDataQueue::default();
    assert_eq!(reopened.take(id), Err("data not found"));
    let new_id = enqueue(&reopened, "new");
    assert_ne!(id, new_id);
    assert_eq!(old.take(new_id), Err("channel webview closed"));
    assert_eq!(reopened.take(new_id).unwrap(), "new");
  }

  #[test]
  fn failed_dispatch_releases_payload() {
    let queue = ChannelDataQueue::default();
    let mut id = None;
    assert!(queue
      .deliver("pending", |value| {
        id = Some(value);
        Err::<(), _>(io::Error::other("eval failed"))
      })
      .is_err());
    assert_eq!(queue.take(id.unwrap()), Err("data not found"));
  }

  #[test]
  fn closing_during_dispatch_cannot_repopulate_queue() {
    let queue = ChannelDataQueue::default();
    let clone = queue.clone();
    let id = enqueue(&queue, "older");
    queue
      .deliver::<io::Error>("newer", |_| {
        clone.close();
        Ok(())
      })
      .unwrap();
    assert_eq!(queue.take(id), Err("channel webview closed"));
    assert!(queue.0.lock().unwrap().data.is_empty());
  }
}
