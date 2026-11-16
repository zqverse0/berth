use super::{
    key_code_lookup_bits, key_code_to_bytes, key_string_lookup_key, key_string_lookup_string,
    KeyBindingStore, KEYC_ANY, KEYC_CTRL, KEYC_META, KEYC_SHIFT,
};

#[test]
fn key_lookup_round_trips_named_keys_and_modifiers() {
    let key = key_string_lookup_string("C-M-Left").expect("key parses");
    assert_eq!(key_string_lookup_key(key, false), "C-M-Left");
    assert_eq!(
        key_string_lookup_key(key_code_lookup_bits(key), false),
        "C-M-Left"
    );
}

#[test]
fn key_lookup_accepts_hex_and_user_keys() {
    assert_eq!(key_string_lookup_string("0x41"), Some(b'A' as u64));
    assert_eq!(key_string_lookup_string("Any"), Some(KEYC_ANY));
    assert_eq!(
        key_string_lookup_string("user42"),
        key_string_lookup_string("User42")
    );
    assert_eq!(
        key_string_lookup_key(key_string_lookup_string("User42").expect("user key"), false),
        "User42"
    );
}

#[test]
fn key_lookup_accepts_mouse_keys() {
    let key = key_string_lookup_string("MouseDown1Pane").expect("mouse key parses");
    assert_eq!(key_string_lookup_key(key, false), "MouseDown1Pane");
}

#[test]
fn key_lookup_accepts_short_ctrl_notation() {
    let key = key_string_lookup_string("^B").expect("short ctrl parses");
    assert_eq!(key, (b'b' as u64) | KEYC_CTRL);
}

#[test]
fn key_lookup_canonicalizes_ctrl_bracket_as_escape() {
    for input in ["C-[", "^["] {
        let key = key_string_lookup_string(input).expect("ctrl bracket parses");
        assert_eq!(key_string_lookup_key(key, false), "Escape");
    }
}

#[test]
fn key_code_to_bytes_encodes_ascii_control_and_utf8() {
    assert_eq!(
        key_code_to_bytes(key_string_lookup_string("Enter").unwrap()),
        Some(vec![13])
    );
    assert_eq!(
        key_code_to_bytes(key_string_lookup_string("S-Enter").unwrap()),
        Some(vec![10])
    );
    assert_eq!(
        key_code_to_bytes(key_string_lookup_string("C-c").unwrap()),
        Some(vec![3])
    );
    let utf8 = key_code_to_bytes(key_string_lookup_string("é").unwrap()).expect("utf8 bytes");
    assert_eq!(String::from_utf8(utf8).unwrap(), "é");
}

#[test]
fn default_store_loads_prefix_root_and_copy_tables() {
    let store = KeyBindingStore::default();
    assert!(store.table("prefix").is_some());
    assert!(store.table("root").is_some());
    assert!(store.table("copy-mode").is_some());
    assert!(store.table("copy-mode-vi").is_some());
}

#[test]
fn modifiers_are_case_insensitive() {
    let key = key_string_lookup_string("c-m-s-a").expect("modifiers parse");
    assert_eq!(key_string_lookup_key(key, false), format!("C-M-S-{}", 'a'));
    assert_eq!(
        key & (KEYC_CTRL | KEYC_META | KEYC_SHIFT),
        KEYC_CTRL | KEYC_META | KEYC_SHIFT
    );
}
