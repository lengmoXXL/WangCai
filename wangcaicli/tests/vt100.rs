//! Guards the vt100 pin in the workspace manifest.

fn sizes() -> impl Iterator<Item = (u16, u16)> {
    const DIMENSIONS: [u16; 3] = [1, 2, 10];
    DIMENSIONS.into_iter().flat_map(|rows| DIMENSIONS.into_iter().map(move |cols| (rows, cols)))
}

#[test]
fn wide_char_on_narrow_screen() {
    for (rows, cols) in sizes() {
        vt100::Parser::new(rows, cols, 0).process("あ".as_bytes());
    }
}

#[test]
fn wrapping_on_one_row_screen() {
    for (rows, cols) in sizes() {
        vt100::Parser::new(rows, cols, 0).process(b"abcdefghijk");
    }
}

#[test]
fn resize_to_one_column_with_a_wide_char_then_clear() {
    for (rows, cols) in sizes() {
        let mut parser = vt100::Parser::new(rows, cols, 0);
        parser.process("あ".as_bytes());
        parser.screen_mut().set_size(rows, 1);
        parser.process(b"\x1b[K");
    }
}

#[test]
fn shrink_with_wide_glyph_at_the_new_right_edge() {
    let mut parser = vt100::Parser::new(60, 180, 0);
    parser.process("keep\x1b[1;53Hあ".as_bytes());
    parser.screen_mut().set_size(60, 53);
    parser.process(b"\x1b[1;53H\x1b[K");
    assert_eq!(parser.screen().contents(), "keep");
}
