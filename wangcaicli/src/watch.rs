use anyhow::{Result, bail};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinHandle};

// One save is never one event: an editor writes, renames and chmods the same path several times. A batch
// goes out once the writes have been quiet for this long, and at the latest MAX_WAIT after it opened, so a
// build that keeps writing still reports while it runs.
const QUIET: Duration = Duration::from_millis(200);
const MAX_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy)]
enum Change {
    Created,
    Modified,
    Removed,
}

fn record(pending: &mut BTreeMap<String, Change>, event: Event, root: &Path, given: &str) {
    let change = match event.kind {
        EventKind::Create(_) => Change::Created,
        EventKind::Remove(_) => Change::Removed,
        EventKind::Modify(_) => Change::Modified,
        // Reading or checking a path is not a change; waking every plugin over one would be the same as
        // having no watch at all.
        _ => return,
    };
    for path in event.paths {
        // A path is reported the way the caller named the root: macOS hands back the resolved one (/tmp
        // arrives as /private/tmp), and a subscriber comparing what it gets against the root it asked for
        // would never match it.
        let named = match path.strip_prefix(root) {
            Ok(rest) if rest.as_os_str().is_empty() => given.to_owned(),
            Ok(rest) => Path::new(given).join(rest).to_string_lossy().into_owned(),
            Err(_) => path.to_string_lossy().into_owned(),
        };
        pending.insert(named, change);
    }
}

/// The next change the watch reported. A notify error is not a change — a watch can fail on one subtree and
/// keep working on the rest — and `None` says the watch is over.
async fn next(events: &mut mpsc::UnboundedReceiver<notify::Result<Event>>) -> Option<Event> {
    loop {
        match events.recv().await {
            Some(Ok(event)) => return Some(event),
            Some(Err(_)) => {}
            None => return None,
        }
    }
}

pub struct Batch {
    pub watch_id: String,
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

/// Watches one path and reports what changed under it. The task owns the watcher: dropping it, which is
/// what aborting the task does, ends the watch.
pub fn start(
    path: &str,
    recursive: bool,
    watch_id: &str,
    batches: mpsc::Sender<Batch>,
) -> Result<JoinHandle<()>> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        bail!("Watch path must be absolute");
    }
    if !path.exists() {
        bail!("Watch path does not exist");
    }
    let given = path.to_string_lossy().into_owned();
    let root = std::fs::canonicalize(&path)?;
    let (changes, mut events) = mpsc::unbounded_channel();
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            let _ = changes.send(event);
        },
        Config::default(),
    )?;
    watcher.watch(
        &path,
        if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        },
    )?;
    let watch_id = watch_id.to_owned();
    Ok(tokio::spawn(async move {
        let _watcher = watcher;
        let mut pending: BTreeMap<String, Change> = BTreeMap::new();
        loop {
            let Some(event) = next(&mut events).await else {
                break;
            };
            let opened = Instant::now();
            record(&mut pending, event, &root, &given);
            while opened.elapsed() < MAX_WAIT {
                let left = MAX_WAIT.saturating_sub(opened.elapsed());
                match tokio::time::timeout(QUIET.min(left), next(&mut events)).await {
                    Ok(Some(event)) => record(&mut pending, event, &root, &given),
                    // Nothing more is coming. A watch that ended here still sends this batch; the receive
                    // that follows sees the closed channel and ends the task.
                    _ => break,
                }
            }
            let (mut created, mut modified, mut removed) = (Vec::new(), Vec::new(), Vec::new());
            for (path, change) in std::mem::take(&mut pending) {
                let bucket = match change {
                    Change::Created => &mut created,
                    Change::Modified => &mut modified,
                    Change::Removed => &mut removed,
                };
                bucket.push(path);
            }
            if batches
                .send(Batch {
                    watch_id: watch_id.clone(),
                    created,
                    modified,
                    removed,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    }))
}
