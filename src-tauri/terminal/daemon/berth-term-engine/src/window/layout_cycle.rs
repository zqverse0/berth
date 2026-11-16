use berth_term_proto::LayoutName;

use super::Window;

impl Window {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn set_layout(&mut self, layout: LayoutName) {
        self.set_layout_with_main_pane_size(layout, None, None);
    }

    pub(crate) fn set_layout_with_main_pane_size(
        &mut self,
        layout: LayoutName,
        main_width: Option<u16>,
        main_height: Option<u16>,
    ) {
        self.auto_unzoom();
        self.layout = layout;
        self.last_layout = Some(layout);
        self.requested_main_width = main_width;
        self.requested_main_height = main_height;
        self.rebuild_named_layout_tree(layout);
    }

    pub(crate) fn recalculate_geometry(&mut self) {
        if let Some(tree) = &mut self.layout_tree {
            tree.resize(self.size);
            tree.apply_to_panes(&mut self.panes);
        }
    }
}

#[cfg(test)]
mod tests {
    use berth_term_proto::{LayoutName, ResizePaneAdjustment, SplitDirection, TerminalSize};

    use crate::PaneId;

    use super::Window;

    #[test]
    fn selecting_named_layout_resets_resized_split_tree_main_size_like_tmux() {
        let mut window = Window::new(TerminalSize {
            cols: 120,
            rows: 35,
        });
        window.split_after_position_with_id_and_direction(
            0,
            PaneId::new(1),
            SplitDirection::Vertical,
        );
        window.split_after_position_with_id_and_direction(
            0,
            PaneId::new(2),
            SplitDirection::Horizontal,
        );
        window.split_after_position_with_id_and_direction(
            1,
            PaneId::new(3),
            SplitDirection::Vertical,
        );
        window.select_pane(2);

        assert!(window.resize_pane_by(2, ResizePaneAdjustment::Right { cells: 7 }));
        assert_eq!(window.pane(0).expect("pane exists").geometry().cols(), 60);

        window.set_layout(LayoutName::MainHorizontal);
        window.set_layout(LayoutName::MainVertical);

        assert_eq!(window.pane(0).expect("pane exists").geometry().cols(), 80);
    }
}
