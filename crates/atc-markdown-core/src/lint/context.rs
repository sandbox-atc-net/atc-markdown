//! What the rules look at: the source lines (with code, front matter and HTML
//! marked), and the headings, lists, code blocks and other blocks from the
//! syntax tree, all with 1-based line numbers.

use std::borrow::Cow;

use comrak::nodes::{AstNode, ListType, NodeValue};

use super::{Issue, TextEdit, rule_info};

/// What a source line belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    /// Ordinary Markdown (paragraphs, headings, lists, tables, quotes, blanks).
    Text,
    /// The `---` YAML block at the top.
    FrontMatter,
    /// The opening or closing line of a fenced code block.
    Fence,
    /// Inside a code block.
    Code,
    /// An HTML block.
    Html,
}

#[derive(Debug)]
pub(super) struct Line<'a> {
    /// Byte offset of the line in the text.
    pub start: usize,
    /// The line without its line break.
    pub text: &'a str,
}

#[derive(Debug)]
pub(super) struct Heading {
    pub level: u8,
    pub setext: bool,
    pub closed: bool,
    pub start_line: usize,
    pub end_line: usize,
    /// 0-based byte column of the first `#` or text character.
    pub col: usize,
    pub text: String,
    /// Directly in the document (not in a list or quote).
    pub top_level: bool,
}

#[derive(Debug)]
pub(super) struct Item {
    pub line: usize,
    /// 0-based byte column of the marker.
    pub col: usize,
    /// `*`, `-` or `+`; `.` or `)` for ordered lists.
    pub marker: char,
    pub number: Option<u64>,
    /// Length of the marker in bytes (`-` is 1, `10.` is 3).
    pub marker_len: usize,
    /// Spaces between the marker and the text (None for an empty item or a tab).
    pub spaces_after: Option<usize>,
    pub blocks: usize,
}

#[derive(Debug)]
#[allow(clippy::struct_excessive_bools, reason = "plain facts about a list")]
pub(super) struct List {
    pub ordered: bool,
    pub start_line: usize,
    pub end_line: usize,
    /// Number of lists this one is nested in.
    pub depth: usize,
    /// All lists it is nested in are bullet lists, and it is not in a quote.
    pub only_bullet_parents: bool,
    pub in_quote: bool,
    /// Directly inside a list item (a sub-list).
    pub in_item: bool,
    pub top_level: bool,
    pub items: Vec<Item>,
}

#[derive(Debug)]
pub(super) struct CodeBlock {
    pub fenced: bool,
    pub start_line: usize,
    pub end_line: usize,
    pub closed: bool,
    pub info: String,
    /// 0-based byte column of the fence (or of the code, for indented blocks).
    pub col: usize,
    /// Lines with code (without the fences).
    pub content_lines: std::ops::RangeInclusive<usize>,
}

#[derive(Debug)]
pub(super) struct Block {
    pub start_line: usize,
    pub end_line: usize,
}

/// Byte ranges per line (index 0 = line 1).
type LineSpans = Vec<Vec<(usize, usize)>>;

pub(super) struct Ctx<'a> {
    pub text: &'a str,
    pub lines: Vec<Line<'a>>,
    pub kinds: Vec<Kind>,
    /// Per line: byte ranges of inline code spans (including the backticks).
    code_spans: LineSpans,
    /// Per line: code spans that start and end on it.
    whole_spans: LineSpans,
    pub root: &'a AstNode<'a>,
    /// Number of front matter lines at the top (0 if none).
    pub front_matter_lines: usize,
    /// The front matter has a `title:`, which acts as the top-level heading.
    pub front_matter_title: bool,
    pub wiki: bool,
    pub headings: Vec<Heading>,
    pub lists: Vec<List>,
    pub code_blocks: Vec<CodeBlock>,
    pub quotes: Vec<Block>,
    pub table_lines: Vec<bool>,
}

impl std::fmt::Debug for Ctx<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ctx")
            .field("lines", &self.lines.len())
            .finish_non_exhaustive()
    }
}

impl<'a> Ctx<'a> {
    pub fn new(text: &'a str, root: &'a AstNode<'a>, wiki: bool) -> Self {
        let mut lines = Vec::new();
        let mut start = 0;
        for piece in text.split_inclusive('\n') {
            let body = piece.strip_suffix('\n').unwrap_or(piece);
            let body = body.strip_suffix('\r').unwrap_or(body);
            lines.push(Line { start, text: body });
            start += piece.len();
        }
        let count = lines.len();
        let mut ctx = Self {
            text,
            lines,
            kinds: vec![Kind::Text; count],
            code_spans: Vec::new(),
            whole_spans: Vec::new(),
            root,
            front_matter_lines: 0,
            front_matter_title: false,
            wiki,
            headings: Vec::new(),
            lists: Vec::new(),
            code_blocks: Vec::new(),
            quotes: Vec::new(),
            table_lines: vec![false; count],
        };
        ctx.collect();
        (ctx.code_spans, ctx.whole_spans) = ctx.find_code_spans();
        ctx
    }

    fn collect(&mut self) {
        for node in self.root.descendants() {
            let data = node.data.borrow();
            let start_line = data.sourcepos.start.line;
            let end_line = data.sourcepos.end.line.max(start_line);
            let col = data.sourcepos.start.column.saturating_sub(1);
            match &data.value {
                NodeValue::FrontMatter(raw) => {
                    let mut n = 0;
                    for (i, line) in raw.lines().enumerate() {
                        if i > 0 && matches!(line.trim_end(), "---" | "...") {
                            n = i + 1;
                            break;
                        }
                    }
                    self.front_matter_lines = n.min(self.lines.len());
                    self.mark(1, self.front_matter_lines, Kind::FrontMatter);
                    self.front_matter_title =
                        raw.lines().skip(1).take(n.saturating_sub(2)).any(|l| {
                            let l = l.trim_start().trim_start_matches(['"', '\'']);
                            l.len() > 5
                                && l[..5].eq_ignore_ascii_case("title")
                                && l[5..]
                                    .trim_start_matches(['"', '\''])
                                    .trim_start()
                                    .starts_with([':', '='])
                        });
                }
                NodeValue::CodeBlock(code) => {
                    let closed = code.fenced && code.closed && end_line > start_line;
                    let content_lines = if code.fenced {
                        (start_line + 1)..=(if closed { end_line - 1 } else { end_line })
                    } else {
                        start_line..=end_line
                    };
                    if code.fenced {
                        self.mark(start_line, start_line, Kind::Fence);
                        if closed {
                            self.mark(end_line, end_line, Kind::Fence);
                        }
                    }
                    self.mark(*content_lines.start(), *content_lines.end(), Kind::Code);
                    let col = if code.fenced {
                        self.line_text(start_line)
                            .find(char::from(code.fence_char))
                            .unwrap_or(col)
                    } else {
                        col
                    };
                    self.code_blocks.push(CodeBlock {
                        fenced: code.fenced,
                        start_line,
                        end_line,
                        closed,
                        info: code.info.clone(),
                        col,
                        content_lines,
                    });
                }
                NodeValue::HtmlBlock(_) => self.mark(start_line, end_line, Kind::Html),
                NodeValue::Table(_) => {
                    for n in start_line..=end_line.min(self.lines.len()) {
                        self.table_lines[n - 1] = true;
                    }
                }
                NodeValue::BlockQuote | NodeValue::Alert(_) | NodeValue::MultilineBlockQuote(_) => {
                    self.quotes.push(Block {
                        start_line,
                        end_line,
                    });
                }
                NodeValue::Heading(h) => {
                    let top_level = node
                        .parent()
                        .is_some_and(|p| matches!(p.data.borrow().value, NodeValue::Document));
                    self.headings.push(Heading {
                        level: h.level,
                        setext: h.setext,
                        closed: h.closed,
                        start_line,
                        end_line,
                        col,
                        text: plain_text(node),
                        top_level,
                    });
                }
                NodeValue::List(list) => {
                    let list = self.list(
                        node,
                        list.list_type == ListType::Ordered,
                        start_line,
                        end_line,
                    );
                    self.lists.push(list);
                }
                _ => {}
            }
        }
    }

    fn list(
        &self,
        node: &'a AstNode<'a>,
        ordered: bool,
        start_line: usize,
        end_line: usize,
    ) -> List {
        let mut depth = 0;
        let mut only_bullet_parents = true;
        let mut in_quote = false;
        for ancestor in node.ancestors().skip(1) {
            match &ancestor.data.borrow().value {
                NodeValue::List(l) => {
                    depth += 1;
                    if l.list_type == ListType::Ordered {
                        only_bullet_parents = false;
                    }
                }
                NodeValue::BlockQuote | NodeValue::Alert(_) | NodeValue::MultilineBlockQuote(_) => {
                    in_quote = true;
                }
                _ => {}
            }
        }
        let parent = node.parent().map(|p| p.data.borrow().value.clone());
        let items = node
            .children()
            .filter_map(|child| {
                let data = child.data.borrow();
                let NodeValue::Item(_) = data.value else {
                    return None;
                };
                let line = data.sourcepos.start.line;
                let col = data.sourcepos.start.column.saturating_sub(1);
                Some(self.item(line, col, ordered, child.children().count()))
            })
            .collect();
        List {
            ordered,
            start_line,
            end_line,
            depth,
            only_bullet_parents: only_bullet_parents && !in_quote,
            in_quote,
            in_item: matches!(parent, Some(NodeValue::Item(_))),
            top_level: matches!(parent, Some(NodeValue::Document)),
            items,
        }
    }

    fn item(&self, line: usize, col: usize, ordered: bool, blocks: usize) -> Item {
        let text = self.line_text(line);
        let rest = text.get(col..).unwrap_or_default();
        let (marker, number, marker_len) = if ordered {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let delim = rest[digits..].chars().next().unwrap_or('.');
            (delim, rest[..digits].parse().ok(), digits + 1)
        } else {
            (rest.chars().next().unwrap_or('*'), None, 1)
        };
        let after = rest.get(marker_len..).unwrap_or_default();
        let spaces = after.bytes().take_while(|&b| b == b' ').count();
        let next = after.as_bytes().get(spaces);
        let spaces_after = match next {
            None | Some(b'\t') => None,
            Some(_) => Some(spaces),
        };
        Item {
            line,
            col,
            marker,
            number,
            marker_len,
            spaces_after,
            blocks,
        }
    }

    fn mark(&mut self, from: usize, to: usize, kind: Kind) {
        let to = to.min(self.kinds.len());
        for n in from.max(1)..=to {
            self.kinds[n - 1] = kind;
        }
    }

    /// The text of a 1-based line ("" past the end).
    pub fn line_text(&self, line: usize) -> &'a str {
        line.checked_sub(1)
            .and_then(|i| self.lines.get(i))
            .map_or("", |l| l.text)
    }

    pub fn kind(&self, line: usize) -> Kind {
        line.checked_sub(1)
            .and_then(|i| self.kinds.get(i))
            .copied()
            .unwrap_or(Kind::Text)
    }

    /// True for an ordinary Markdown line (not code, front matter or an HTML block).
    pub fn is_text(&self, line: usize) -> bool {
        self.kind(line) == Kind::Text
    }

    /// Empty, apart from blockquote markers and spaces.
    pub fn is_blank(&self, line: usize) -> bool {
        self.line_text(line)
            .trim_start_matches(|c: char| c == '>' || c.is_whitespace())
            .is_empty()
    }

    /// True if the text before `col` on the line has a list marker (the block
    /// starts its container, so there is no line before it to check).
    pub fn starts_container(&self, line: usize, col: usize) -> bool {
        let before = self.line_text(line).get(..col).unwrap_or_default();
        !before
            .trim_matches(|c: char| c == '>' || c.is_whitespace())
            .is_empty()
    }

    /// The line without inline code and escaped characters (replaced by `x`,
    /// so byte columns stay the same).
    pub fn masked(&self, line: usize) -> Cow<'a, str> {
        let text = self.line_text(line);
        let spans = self
            .code_spans
            .get(line.wrapping_sub(1))
            .map_or(&[][..], Vec::as_slice);
        if spans.is_empty() && !text.contains('\\') {
            return Cow::Borrowed(text);
        }
        let mut bytes = text.as_bytes().to_vec();
        for &(from, to) in spans {
            bytes[from..to].fill(b'x');
        }
        let mut i = 0;
        while i + 1 < bytes.len() {
            if bytes[i] == b'\\' && bytes[i + 1].is_ascii_punctuation() {
                bytes[i] = b'x';
                bytes[i + 1] = b'x';
                i += 2;
            } else {
                i += 1;
            }
        }
        // Only whole code spans (between ASCII backticks) and ASCII pairs were replaced.
        Cow::Owned(String::from_utf8(bytes).unwrap_or_else(|_| text.to_owned()))
    }

    /// Inline code spans that start and end on this line (byte ranges, backticks included).
    pub fn code_spans(&self, line: usize) -> &[(usize, usize)] {
        self.whole_spans
            .get(line.wrapping_sub(1))
            .map_or(&[], Vec::as_slice)
    }

    /// Code spans per line. Spans may cross lines within a paragraph, so the
    /// lines of each paragraph are scanned together.
    fn find_code_spans(&self) -> (LineSpans, LineSpans) {
        let count = self.line_count();
        let mut spans = vec![Vec::new(); count];
        let mut whole = vec![Vec::new(); count];
        let heading_lines: std::collections::HashSet<usize> = self
            .headings
            .iter()
            .filter(|h| !h.setext)
            .map(|h| h.start_line)
            .collect();
        let single = |n: usize| heading_lines.contains(&n) || self.table_lines[n - 1];
        let mut line = 1;
        while line <= count {
            if !self.is_text(line) || self.is_blank(line) {
                line += 1;
                continue;
            }
            // A group: one heading or table row, or a run of other text lines.
            let mut end = line;
            if !single(line) {
                while end < count
                    && self.is_text(end + 1)
                    && !self.is_blank(end + 1)
                    && !single(end + 1)
                {
                    end += 1;
                }
            }
            let joined: Vec<&str> = (line..=end).map(|n| self.line_text(n)).collect();
            let joined = joined.join("\n");
            for (from, to) in scan_code_spans(joined.as_bytes()) {
                // Split the span into its part on each line.
                let mut offset = 0;
                for n in line..=end {
                    let len = self.line_text(n).len();
                    let (start, stop) = (from.max(offset), to.min(offset + len));
                    if start < stop {
                        spans[n - 1].push((start - offset, stop - offset));
                        if start == from && stop == to {
                            whole[n - 1].push((start - offset, stop - offset));
                        }
                    }
                    offset += len + 1;
                }
            }
            line = end + 1;
        }
        (spans, whole)
    }

    /// An issue covering columns `from..to` (0-based bytes) of a line.
    pub fn issue(
        &self,
        rule: &'static str,
        line: usize,
        from: usize,
        to: usize,
        message: impl Into<String>,
    ) -> Issue {
        let start = self
            .lines
            .get(line.wrapping_sub(1))
            .map_or(self.text.len(), |l| l.start);
        let len = self.line_text(line).len();
        Issue {
            rule,
            alias: rule_info(rule).map_or("", |r| r.alias),
            message: message.into(),
            line,
            start: start + from.min(len),
            end: start + to.min(len).max(from.min(len)),
            fix: None,
        }
    }

    /// An issue covering a whole line.
    pub fn line_issue(&self, rule: &'static str, line: usize, message: impl Into<String>) -> Issue {
        let len = self.line_text(line).len();
        self.issue(rule, line, 0, len, message)
    }

    /// Byte offset of a column on a line.
    pub fn offset(&self, line: usize, col: usize) -> usize {
        self.lines
            .get(line.wrapping_sub(1))
            .map_or(self.text.len(), |l| l.start + col.min(l.text.len()))
    }

    /// An edit replacing columns `from..to` of a line.
    pub fn edit(&self, line: usize, from: usize, to: usize, insert: impl Into<String>) -> TextEdit {
        TextEdit {
            start: self.offset(line, from),
            end: self.offset(line, to),
            insert: insert.into(),
        }
    }

    /// An edit that inserts a blank line before a line, copying its quote prefix.
    pub fn insert_blank_before(&self, line: usize) -> TextEdit {
        let prefix = quote_prefix(self.line_text(line));
        TextEdit {
            start: self.offset(line, 0),
            end: self.offset(line, 0),
            insert: format!("{}{}", prefix.trim_end(), self.eol()),
        }
    }

    /// An edit that inserts a blank line after a line.
    pub fn insert_blank_after(&self, line: usize) -> TextEdit {
        let text = self.line_text(line);
        let prefix = quote_prefix(text);
        let end = self.offset(line, text.len());
        TextEdit {
            start: end,
            end,
            insert: format!("{}{}", self.eol(), prefix.trim_end()),
        }
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// The line break the text uses (`\r\n` if its first line ends with one).
    pub fn eol(&self) -> &'static str {
        match self.text.find('\n') {
            Some(i) if self.text[..i].ends_with('\r') => "\r\n",
            _ => "\n",
        }
    }
}

/// Code spans in text (byte ranges, backticks included), `CommonMark` style:
/// a run of N backticks is closed by the next run of exactly N.
fn scan_code_spans(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
        let mut j = i + run;
        let mut close = None;
        while j < bytes.len() {
            if bytes[j] == b'`' {
                let other = bytes[j..].iter().take_while(|&&b| b == b'`').count();
                if other == run {
                    close = Some(j);
                    break;
                }
                j += other;
            } else {
                j += 1;
            }
        }
        match close {
            Some(j) => {
                spans.push((i, j + run));
                i = j + run;
            }
            None => i += run,
        }
    }
    spans
}

/// The `> > ` part at the start of a line inside block quotes.
pub(super) fn quote_prefix(text: &str) -> &str {
    let mut end = 0;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' => i += 1,
            b'>' => {
                i += 1;
                end = i;
            }
            _ => break,
        }
    }
    &text[..end]
}

/// The text of a node's inline content.
pub(super) fn plain_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut text = String::new();
    for child in node.descendants() {
        match &child.data.borrow().value {
            NodeValue::Text(t) => text.push_str(t),
            NodeValue::Code(c) => text.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => text.push(' '),
            _ => {}
        }
    }
    text
}
