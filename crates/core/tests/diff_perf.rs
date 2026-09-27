//! Timing checks for the diff engine. Ignored by default; run with
//! `cargo test --release -p fast_reviewer_core --test diff_perf -- --ignored --nocapture`.
use std::time::Instant;

use fast_reviewer_core::diff::diff_texts;

fn source(lines: usize) -> String {
    (0..lines)
        .map(|i| match i % 7 {
            0 => format!("export function handler{i}(req: Request): Response {{\n"),
            1 => format!("  const value{i} = await fetchData(req.params.id, {{ retry: {i} }});\n"),
            2 => "  if (!value) {\n".to_owned(),
            3 => "    return new Response(null, { status: 404 });\n".to_owned(),
            4 => "  }\n".to_owned(),
            5 => format!("  return json({{ id: {i}, label: \"item {i}\" }});\n"),
            _ => "}\n".to_owned(),
        })
        .collect()
}

fn time<F: FnMut() -> usize>(label: &str, runs: u32, mut f: F) -> f64 {
    f();
    let start = Instant::now();
    let mut n = 0;
    for _ in 0..runs {
        n += f();
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / runs as f64;
    println!("{label}: {ms:.2} ms/run ({} hunks)", n / runs as usize);
    ms
}

#[test]
#[ignore]
fn timing() {
    let old = source(10_000);

    // Scattered edits: every 50th line modified, some inserts and deletes.
    let new: String = old
        .lines()
        .enumerate()
        .filter(|(i, _)| i % 997 != 0)
        .map(|(i, l)| match i % 50 {
            0 => format!("{} // edited\n", l.replace("retry", "retries")),
            25 => format!("{l}\n  log(\"inserted {i}\");\n"),
            _ => format!("{l}\n"),
        })
        .collect();
    let scattered = time("10k lines, scattered edits", 20, || {
        diff_texts(&old, &new, 3).len()
    });

    // Every line changed: one giant change block, stresses pairing + word diff.
    let rewritten = old.replace("value", "result");
    let rewrite = time("10k lines, every line touched", 5, || {
        diff_texts(&old, &rewritten, 3).len()
    });

    // Completely unrelated files.
    let other: String = (0..10_000)
        .map(|i| format!("unrelated line {}\n", i * 7919 % 10_007))
        .collect();
    let unrelated = time("10k lines vs 10k unrelated", 5, || {
        diff_texts(&old, &other, 3).len()
    });

    let added = time("10k-line added file", 20, || diff_texts("", &old, 3).len());

    if !cfg!(debug_assertions) {
        assert!(scattered < 50.0, "scattered edits took {scattered:.1} ms");
        assert!(added < 50.0);
        assert!(rewrite < 1000.0 && unrelated < 1000.0);
    }
}

#[test]
#[ignore]
fn adversarial_timing() {
    // Few distinct lines in shuffled order: worst case for line matching, bounded by the deadline.
    let mut seed = 42u64;
    let mut rand = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    let alphabet = ["{", "}", "", "  return;", "  x += 1;", "  }", "  {"];
    let a: String = (0..20_000)
        .map(|_| format!("{}\n", alphabet[rand() % alphabet.len()]))
        .collect();
    let b: String = (0..20_000)
        .map(|_| format!("{}\n", alphabet[rand() % alphabet.len()]))
        .collect();
    let ms = time("20k shuffled low-entropy lines", 3, || {
        diff_texts(&a, &b, 3).len()
    });

    // A single 1 MB minified line changed in one place.
    let line: String = (0..100_000).map(|i| format!("a{i}.b;")).collect();
    let changed = line.replacen("a500.b", "a500.c", 1);
    let minified = time("1 MB single-line edit", 3, || {
        diff_texts(&line, &changed, 3).len()
    });

    if !cfg!(debug_assertions) {
        assert!(ms < 1000.0, "{ms:.1} ms");
        assert!(minified < 200.0, "{minified:.1} ms");
    }
}
