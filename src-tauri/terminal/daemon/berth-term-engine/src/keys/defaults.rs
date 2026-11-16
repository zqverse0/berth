// Berth：attach 只提供帮助（berth-cli `ATTACH_KEYS`）列出的按键：C-b d / n / p / 0-9 / w / [ / PPage、
// 鼠标点选与滚轮回看，以及 copy-mode 两张表；其余上游默认键（命令行、菜单、时钟、客户端切换等）不提供。
// 一个终端 Tab 对应一个只有单 pane 的 window，分屏由 GUI 的 Tab 组负责。
// 因此去掉上游的 `"` / `%` 分屏键和菜单里的分屏项，避免 attach 时建出 GUI 看不到的 pane。
// GUI 以 window 名为终端 id、以会话名认项目，所以也去掉 `,` / `$` 重命名键；
// `c` 建出的窗口没有终端 id，新 Tab 走 `berth terminal create`；菜单里的同类项一并去掉。
pub(crate) const DEFAULT_BINDING_STRINGS: &[&str] = &[
    "bind -N 'Select window 0' 0 { select-window -t:=0 }",
    "bind -N 'Select window 1' 1 { select-window -t:=1 }",
    "bind -N 'Select window 2' 2 { select-window -t:=2 }",
    "bind -N 'Select window 3' 3 { select-window -t:=3 }",
    "bind -N 'Select window 4' 4 { select-window -t:=4 }",
    "bind -N 'Select window 5' 5 { select-window -t:=5 }",
    "bind -N 'Select window 6' 6 { select-window -t:=6 }",
    "bind -N 'Select window 7' 7 { select-window -t:=7 }",
    "bind -N 'Select window 8' 8 { select-window -t:=8 }",
    "bind -N 'Select window 9' 9 { select-window -t:=9 }",
    "bind -N 'Enter copy mode' [ { copy-mode }",
    "bind -N 'Detach the current client' d { detach-client }",
    "bind -N 'Select the next window' n { next-window }",
    "bind -N 'Select the previous window' p { previous-window }",
    "bind -N 'Choose a window from a list' w { choose-tree -Zw }",
    "bind -N 'Enter copy mode and scroll up' PPage { copy-mode -u }",
    "bind -n MouseDown1Pane { select-pane -t=; send -M }",
    "bind -n MouseDrag1Pane { if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { copy-mode -M } }",
    "bind -n WheelUpPane { if -F '#{||:#{alternate_on},#{||:#{pane_in_mode},#{mouse_any_flag}}}' { send -M } { copy-mode -e } }",
    "bind -n MouseDown2Pane { select-pane -t=; if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { paste -p } }",
    "bind -n DoubleClick1Pane { select-pane -t=; if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { copy-mode -H; send -X select-word; run -d0.3; send -X copy-pipe-and-cancel } }",
    "bind -n TripleClick1Pane { select-pane -t=; if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { copy-mode -H; send -X select-line; run -d0.3; send -X copy-pipe-and-cancel } }",
    "bind -n MouseDrag1Border { resize-pane -M }",
    "bind -n MouseDown1Status { select-window -t= }",
    "bind -n WheelDownStatus { next-window }",
    "bind -n WheelUpStatus { previous-window }",
    "bind -Tcopy-mode C-Space { send -X begin-selection }",
    "bind -Tcopy-mode C-a { send -X start-of-line }",
    "bind -Tcopy-mode C-c { send -X cancel }",
    "bind -Tcopy-mode C-e { send -X end-of-line }",
    "bind -Tcopy-mode C-f { send -X cursor-right }",
    "bind -Tcopy-mode C-b { send -X cursor-left }",
    "bind -Tcopy-mode C-g { send -X clear-selection }",
    "bind -Tcopy-mode C-k { send -X copy-pipe-end-of-line-and-cancel }",
    "bind -Tcopy-mode C-n { send -X cursor-down }",
    "bind -Tcopy-mode C-p { send -X cursor-up }",
    "bind -Tcopy-mode C-r { command-prompt -T search -ip'(search up)' -I'#{pane_search_string}' { send -X search-backward-incremental -- '%%' } }",
    "bind -Tcopy-mode C-s { command-prompt -T search -ip'(search down)' -I'#{pane_search_string}' { send -X search-forward-incremental -- '%%' } }",
    "bind -Tcopy-mode C-v { send -X page-down }",
    "bind -Tcopy-mode C-w { send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode Escape { send -X cancel }",
    "bind -Tcopy-mode Space { send -X page-down }",
    "bind -Tcopy-mode , { send -X jump-reverse }",
    "bind -Tcopy-mode \\; { send -X jump-again }",
    "bind -Tcopy-mode F { command-prompt -1p'(jump backward)' { send -X jump-backward -- '%%' } }",
    "bind -Tcopy-mode N { send -X search-reverse }",
    "bind -Tcopy-mode P { send -X toggle-position }",
    "bind -Tcopy-mode R { send -X rectangle-toggle }",
    "bind -Tcopy-mode T { command-prompt -1p'(jump to backward)' { send -X jump-to-backward -- '%%' } }",
    "bind -Tcopy-mode X { send -X set-mark }",
    "bind -Tcopy-mode f { command-prompt -1p'(jump forward)' { send -X jump-forward -- '%%' } }",
    "bind -Tcopy-mode g { command-prompt -p'(goto line)' { send -X goto-line -- '%%' } }",
    "bind -Tcopy-mode n { send -X search-again }",
    "bind -Tcopy-mode q { send -X cancel }",
    "bind -Tcopy-mode r { send -X refresh-from-pane }",
    "bind -Tcopy-mode t { command-prompt -1p'(jump to forward)' { send -X jump-to-forward -- '%%' } }",
    "bind -Tcopy-mode Home { send -X start-of-line }",
    "bind -Tcopy-mode End { send -X end-of-line }",
    "bind -Tcopy-mode MouseDown1Pane select-pane",
    "bind -Tcopy-mode MouseDrag1Pane { select-pane; send -X begin-selection }",
    "bind -Tcopy-mode MouseDragEnd1Pane { send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode WheelUpPane { select-pane; send -N5 -X scroll-up }",
    "bind -Tcopy-mode WheelDownPane { select-pane; send -N5 -X scroll-down }",
    "bind -Tcopy-mode DoubleClick1Pane { select-pane; send -X select-word; run -d0.3; send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode TripleClick1Pane { select-pane; send -X select-line; run -d0.3; send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode NPage { send -X page-down }",
    "bind -Tcopy-mode PPage { send -X page-up }",
    "bind -Tcopy-mode Up { send -X cursor-up }",
    "bind -Tcopy-mode Down { send -X cursor-down }",
    "bind -Tcopy-mode Left { send -X cursor-left }",
    "bind -Tcopy-mode Right { send -X cursor-right }",
    "bind -Tcopy-mode M-1 { command-prompt -Np'(repeat)' -I1 { send -N '%%' } }",
    "bind -Tcopy-mode M-2 { command-prompt -Np'(repeat)' -I2 { send -N '%%' } }",
    "bind -Tcopy-mode M-3 { command-prompt -Np'(repeat)' -I3 { send -N '%%' } }",
    "bind -Tcopy-mode M-4 { command-prompt -Np'(repeat)' -I4 { send -N '%%' } }",
    "bind -Tcopy-mode M-5 { command-prompt -Np'(repeat)' -I5 { send -N '%%' } }",
    "bind -Tcopy-mode M-6 { command-prompt -Np'(repeat)' -I6 { send -N '%%' } }",
    "bind -Tcopy-mode M-7 { command-prompt -Np'(repeat)' -I7 { send -N '%%' } }",
    "bind -Tcopy-mode M-8 { command-prompt -Np'(repeat)' -I8 { send -N '%%' } }",
    "bind -Tcopy-mode M-9 { command-prompt -Np'(repeat)' -I9 { send -N '%%' } }",
    "bind -Tcopy-mode M-< { send -X history-top }",
    "bind -Tcopy-mode M-> { send -X history-bottom }",
    "bind -Tcopy-mode M-R { send -X top-line }",
    "bind -Tcopy-mode M-b { send -X previous-word }",
    "bind -Tcopy-mode C-M-b { send -X previous-matching-bracket }",
    "bind -Tcopy-mode M-f { send -X next-word-end }",
    "bind -Tcopy-mode C-M-f { send -X next-matching-bracket }",
    "bind -Tcopy-mode M-m { send -X back-to-indentation }",
    "bind -Tcopy-mode M-r { send -X middle-line }",
    "bind -Tcopy-mode M-v { send -X page-up }",
    "bind -Tcopy-mode M-w { send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode M-x { send -X jump-to-mark }",
    "bind -Tcopy-mode 'M-{' { send -X previous-paragraph }",
    "bind -Tcopy-mode 'M-}' { send -X next-paragraph }",
    "bind -Tcopy-mode M-Up { send -X halfpage-up }",
    "bind -Tcopy-mode M-Down { send -X halfpage-down }",
    "bind -Tcopy-mode C-Up { send -X scroll-up }",
    "bind -Tcopy-mode C-Down { send -X scroll-down }",
    "bind -Tcopy-mode-vi '#' { send -FX search-backward -- '#{copy_cursor_word}' }",
    "bind -Tcopy-mode-vi * { send -FX search-forward -- '#{copy_cursor_word}' }",
    "bind -Tcopy-mode-vi C-c { send -X cancel }",
    "bind -Tcopy-mode-vi C-d { send -X halfpage-down }",
    "bind -Tcopy-mode-vi C-e { send -X scroll-down }",
    "bind -Tcopy-mode-vi C-b { send -X page-up }",
    "bind -Tcopy-mode-vi C-f { send -X page-down }",
    "bind -Tcopy-mode-vi C-h { send -X cursor-left }",
    "bind -Tcopy-mode-vi C-j { send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode-vi Enter { send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode-vi C-u { send -X halfpage-up }",
    "bind -Tcopy-mode-vi C-v { send -X rectangle-toggle }",
    "bind -Tcopy-mode-vi C-y { send -X scroll-up }",
    "bind -Tcopy-mode-vi Escape { send -X clear-selection }",
    "bind -Tcopy-mode-vi Space { send -X begin-selection }",
    "bind -Tcopy-mode-vi '$' { send -X end-of-line }",
    "bind -Tcopy-mode-vi , { send -X jump-reverse }",
    "bind -Tcopy-mode-vi / { command-prompt -T search -p'(search down)' { send -X search-forward -- '%%' } }",
    "bind -Tcopy-mode-vi 0 { send -X start-of-line }",
    "bind -Tcopy-mode-vi 1 { command-prompt -Np'(repeat)' -I1 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 2 { command-prompt -Np'(repeat)' -I2 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 3 { command-prompt -Np'(repeat)' -I3 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 4 { command-prompt -Np'(repeat)' -I4 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 5 { command-prompt -Np'(repeat)' -I5 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 6 { command-prompt -Np'(repeat)' -I6 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 7 { command-prompt -Np'(repeat)' -I7 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 8 { command-prompt -Np'(repeat)' -I8 { send -N '%%' } }",
    "bind -Tcopy-mode-vi 9 { command-prompt -Np'(repeat)' -I9 { send -N '%%' } }",
    "bind -Tcopy-mode-vi : { command-prompt -p'(goto line)' { send -X goto-line -- '%%' } }",
    "bind -Tcopy-mode-vi \\; { send -X jump-again }",
    "bind -Tcopy-mode-vi ? { command-prompt -T search -p'(search up)' { send -X search-backward -- '%%' } }",
    "bind -Tcopy-mode-vi A { send -X append-selection-and-cancel }",
    "bind -Tcopy-mode-vi B { send -X previous-space }",
    "bind -Tcopy-mode-vi D { send -X copy-pipe-end-of-line-and-cancel }",
    "bind -Tcopy-mode-vi E { send -X next-space-end }",
    "bind -Tcopy-mode-vi F { command-prompt -1p'(jump backward)' { send -X jump-backward -- '%%' } }",
    "bind -Tcopy-mode-vi G { send -X history-bottom }",
    "bind -Tcopy-mode-vi H { send -X top-line }",
    "bind -Tcopy-mode-vi J { send -X scroll-down }",
    "bind -Tcopy-mode-vi K { send -X scroll-up }",
    "bind -Tcopy-mode-vi L { send -X bottom-line }",
    "bind -Tcopy-mode-vi M { send -X middle-line }",
    "bind -Tcopy-mode-vi N { send -X search-reverse }",
    "bind -Tcopy-mode-vi P { send -X toggle-position }",
    "bind -Tcopy-mode-vi T { command-prompt -1p'(jump to backward)' { send -X jump-to-backward -- '%%' } }",
    "bind -Tcopy-mode-vi V { send -X select-line }",
    "bind -Tcopy-mode-vi W { send -X next-space }",
    "bind -Tcopy-mode-vi X { send -X set-mark }",
    "bind -Tcopy-mode-vi ^ { send -X back-to-indentation }",
    "bind -Tcopy-mode-vi b { send -X previous-word }",
    "bind -Tcopy-mode-vi e { send -X next-word-end }",
    "bind -Tcopy-mode-vi f { command-prompt -1p'(jump forward)' { send -X jump-forward -- '%%' } }",
    "bind -Tcopy-mode-vi g { send -X history-top }",
    "bind -Tcopy-mode-vi h { send -X cursor-left }",
    "bind -Tcopy-mode-vi j { send -X cursor-down }",
    "bind -Tcopy-mode-vi k { send -X cursor-up }",
    "bind -Tcopy-mode-vi z { send -X scroll-middle }",
    "bind -Tcopy-mode-vi l { send -X cursor-right }",
    "bind -Tcopy-mode-vi n { send -X search-again }",
    "bind -Tcopy-mode-vi o { send -X other-end }",
    "bind -Tcopy-mode-vi q { send -X cancel }",
    "bind -Tcopy-mode-vi r { send -X refresh-from-pane }",
    "bind -Tcopy-mode-vi t { command-prompt -1p'(jump to forward)' { send -X jump-to-forward -- '%%' } }",
    "bind -Tcopy-mode-vi v { send -X rectangle-toggle }",
    "bind -Tcopy-mode-vi w { send -X next-word }",
    "bind -Tcopy-mode-vi '{' { send -X previous-paragraph }",
    "bind -Tcopy-mode-vi '}' { send -X next-paragraph }",
    "bind -Tcopy-mode-vi % { send -X next-matching-bracket }",
    "bind -Tcopy-mode-vi Home { send -X start-of-line }",
    "bind -Tcopy-mode-vi End { send -X end-of-line }",
    "bind -Tcopy-mode-vi MouseDown1Pane { select-pane }",
    "bind -Tcopy-mode-vi MouseDrag1Pane { select-pane; send -X begin-selection }",
    "bind -Tcopy-mode-vi MouseDragEnd1Pane { send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode-vi WheelUpPane { select-pane; send -N5 -X scroll-up }",
    "bind -Tcopy-mode-vi WheelDownPane { select-pane; send -N5 -X scroll-down }",
    "bind -Tcopy-mode-vi DoubleClick1Pane { select-pane; send -X select-word; run -d0.3; send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode-vi TripleClick1Pane { select-pane; send -X select-line; run -d0.3; send -X copy-pipe-and-cancel }",
    "bind -Tcopy-mode-vi BSpace { send -X cursor-left }",
    "bind -Tcopy-mode-vi NPage { send -X page-down }",
    "bind -Tcopy-mode-vi PPage { send -X page-up }",
    "bind -Tcopy-mode-vi Up { send -X cursor-up }",
    "bind -Tcopy-mode-vi Down { send -X cursor-down }",
    "bind -Tcopy-mode-vi Left { send -X cursor-left }",
    "bind -Tcopy-mode-vi Right { send -X cursor-right }",
    "bind -Tcopy-mode-vi M-x { send -X jump-to-mark }",
    "bind -Tcopy-mode-vi C-Up { send -X scroll-up }",
    "bind -Tcopy-mode-vi C-Down { send -X scroll-down }",
];

#[cfg(test)]
mod berth_default_bindings_tests {
    use std::collections::BTreeSet;

    use crate::keys::{key_string_lookup_key, KeyBindingStore};

    fn table_keys(store: &KeyBindingStore, name: &str) -> BTreeSet<String> {
        store
            .table(name)
            .unwrap_or_else(|| panic!("默认按键表缺少 {name}"))
            .active()
            .keys()
            .map(|key| key_string_lookup_key(*key, false))
            .collect()
    }

    fn set(keys: &[&str]) -> BTreeSet<String> {
        keys.iter().map(|key| (*key).to_owned()).collect()
    }

    /// attach 帮助（berth-cli `ATTACH_KEYS`）只承诺这些键；多出或缺少都要先改帮助与本测试。
    #[test]
    fn default_tables_match_documented_attach_keys() {
        let store = KeyBindingStore::with_defaults().expect("默认绑定可解析");

        assert_eq!(
            table_keys(&store, "prefix"),
            set(&[
                "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "PPage", "[", "d", "n", "p", "w"
            ])
        );
        assert_eq!(
            table_keys(&store, "root"),
            set(&[
                "DoubleClick1Pane",
                "MouseDown1Pane",
                "MouseDown1Status",
                "MouseDown2Pane",
                "MouseDrag1Border",
                "MouseDrag1Pane",
                "TripleClick1Pane",
                "WheelDownStatus",
                "WheelUpPane",
                "WheelUpStatus",
            ])
        );
        for table in ["copy-mode", "copy-mode-vi"] {
            assert!(
                !table_keys(&store, table).is_empty(),
                "{table} 回看键表应保留"
            );
        }
    }

    #[test]
    fn documented_prefix_keys_run_expected_commands() {
        let store = KeyBindingStore::with_defaults().expect("默认绑定可解析");
        let prefix = store.table("prefix").expect("prefix 表");
        let command_of = |key: &str| {
            prefix
                .active()
                .iter()
                .find(|(code, _)| key_string_lookup_key(**code, false) == key)
                .map(|(_, binding)| binding.commands().commands()[0].name().to_owned())
                .unwrap_or_else(|| panic!("prefix 表缺少 {key}"))
        };

        assert_eq!(command_of("d"), "detach-client");
        assert_eq!(command_of("n"), "next-window");
        assert_eq!(command_of("p"), "previous-window");
        assert_eq!(command_of("0"), "select-window");
        assert_eq!(command_of("w"), "choose-tree");
        assert_eq!(command_of("["), "copy-mode");
    }
}
