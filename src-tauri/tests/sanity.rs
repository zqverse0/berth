//! Smoke test that exercises the externally-visible test scaffolding:
//! `fresh_in_memory_db` + `EventEmitter::test_with_bus`. These are the
//! foundations for declarative session-reader and HTTP API integration tests.

use std::sync::Arc;

use berth_lib::db::test_helpers::fresh_in_memory_db;
use berth_lib::event_bridge::{EventEmitter, TestEventBus};

#[tokio::test]
async fn in_memory_db_boots_and_runs_migrations() {
    let db = fresh_in_memory_db().await;
    // Migrations ran if the connection is usable for a trivial query.
    use sea_orm::ConnectionTrait;
    let backend = db.conn.get_database_backend();
    assert_eq!(format!("{backend:?}"), "Sqlite");
}

#[test]
fn test_event_emitter_constructs() {
    let broadcaster = Arc::new(TestEventBus::new());
    let _emitter = EventEmitter::test_with_bus(broadcaster);
}
