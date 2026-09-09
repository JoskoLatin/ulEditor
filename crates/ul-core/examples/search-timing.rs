//! How long project-wide search actually takes, over a real folder.
//!
//! The plan holds a decision against `tantivy` — "an index pays off when the
//! corpus is large and queries frequent, but it carries invalidation, and
//! invalidation has no halfway solution" — and the argument rests on a number
//! nobody had measured. This measures it.
//!
//! It is an example rather than a test because there is nothing to assert: the
//! answer is a duration on one machine over one folder, and what it decides is
//! whether an index is worth its invalidation. A test that failed when
//! somebody's disk was busy would be noise.
//!
//!   cargo run -p ul-core --example search-timing -- "C:/Users/you/Documents" riječ

use std::time::Instant;

use ul_core::{SearchQuery, Workspace};

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().unwrap_or_else(|| {
        eprintln!("usage: search-timing <folder> [needle]");
        std::process::exit(2);
    });
    let needle = args.next().unwrap_or_else(|| "ugovor".to_string());

    let mut workspace = Workspace::new();
    let opened = Instant::now();
    workspace.add_root(&root).expect("the folder has to exist");
    println!("root opened in {:?}", opened.elapsed());

    let files = Instant::now();
    let listed = workspace.list_files(100_000).map(|f| f.len()).unwrap_or(0);
    println!("{listed} files walked in {:?}", files.elapsed());

    for pass in 1..=3 {
        let started = Instant::now();
        let outcome = workspace
            .search(&SearchQuery {
                query: needle.clone(),
                case_sensitive: false,
                whole_word: false,
                limit: 500,
                per_file: 50,
            })
            .expect("the search itself does not fail");
        println!(
            "pass {pass}: {} hits, {} files read as text, {} documents for the readers, {:?}{}",
            outcome.hits.len(),
            outcome.scanned,
            outcome.documents.len(),
            started.elapsed(),
            if outcome.truncated {
                " (truncated at the limit)"
            } else {
                ""
            },
        );
    }
}
