use serde::Serialize;
use std::io::{self, Write};
use std::sync::{Mutex, OnceLock};

static OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn output_lock() -> &'static Mutex<()> {
    OUTPUT_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn emit_json<T: Serialize>(value: &T) -> io::Result<()> {
    let _guard = output_lock().lock().expect("output lock poisoned");
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}
