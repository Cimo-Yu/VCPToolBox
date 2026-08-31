use ignore::{DirEntry, WalkBuilder, WalkState};
use regex::Regex;
use serde::{de::{self, Deserializer, Unexpected, Visitor}, Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

const MAX_FILE_SIZE: u64 = 1024 * 1024; // 1MB
const DEFAULT_MAX_RESULTS: usize = 100;

// --- Serde Deserialization Helpers ---
//
// Every flag accepts BOTH its natural JSON type and the string form. The
// original implementation accepted strings only, so an ordinary JSON caller
// sending `{"case_sensitive": true}` was rejected with an `invalid type`
// error while `{"case_sensitive": "true"}` worked. Callers that already send
// strings keep working unchanged.

/// Accepts `true`/`false` and the strings "true"/"false"/"1"/"0" (any case).
fn deserialize_bool_flexible<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoolVisitor;

    impl<'de> Visitor<'de> for BoolVisitor {
        type Value = bool;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a boolean, or a boolean string (true, false, 1, 0)")
        }

        fn visit_bool<E: de::Error>(self, value: bool) -> Result<bool, E> {
            Ok(value)
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<bool, E> {
            match value {
                0 => Ok(false),
                1 => Ok(true),
                other => Err(E::invalid_value(Unexpected::Unsigned(other), &self)),
            }
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<bool, E> {
            match value {
                0 => Ok(false),
                1 => Ok(true),
                other => Err(E::invalid_value(Unexpected::Signed(other), &self)),
            }
        }

        fn visit_str<E: de::Error>(self, value: &str) -> Result<bool, E> {
            match value.trim().to_lowercase().as_str() {
                "true" | "1" | "yes" => Ok(true),
                "false" | "0" | "no" | "" => Ok(false),
                other => Err(E::invalid_value(Unexpected::Str(other), &self)),
            }
        }
    }

    deserializer.deserialize_any(BoolVisitor)
}

/// Accepts an unsigned integer and its string form.
fn deserialize_usize_flexible<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
{
    struct UsizeVisitor;

    impl<'de> Visitor<'de> for UsizeVisitor {
        type Value = usize;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("an unsigned integer, or its string form")
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<usize, E> {
            usize::try_from(value).map_err(|_| E::invalid_value(Unexpected::Unsigned(value), &self))
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<usize, E> {
            usize::try_from(value).map_err(|_| E::invalid_value(Unexpected::Signed(value), &self))
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<usize, E> {
            if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
                Ok(value as usize)
            } else {
                Err(E::invalid_value(Unexpected::Float(value), &self))
            }
        }

        fn visit_str<E: de::Error>(self, value: &str) -> Result<usize, E> {
            value
                .trim()
                .parse::<usize>()
                .map_err(|_| E::invalid_value(Unexpected::Str(value), &self))
        }
    }

    deserializer.deserialize_any(UsizeVisitor)
}

#[derive(Deserialize, Debug)]
struct InputArgs {
    query: String,
    search_path: Option<String>,
    /// Base directory every reported `file_path` is relative to. When absent,
    /// the base is discovered by walking up from the current directory
    /// (`find_project_root`), which is what the original did unconditionally.
    /// Passing it explicitly is the only way a caller can be sure what the
    /// returned paths are relative to.
    base_path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_flexible")]
    case_sensitive: bool,
    #[serde(default, deserialize_with = "deserialize_bool_flexible")]
    whole_word: bool,
    #[serde(default = "default_context", deserialize_with = "deserialize_usize_flexible")]
    context_lines: usize,
    #[serde(default, deserialize_with = "deserialize_bool_flexible")]
    is_regex: bool,
}

fn default_context() -> usize { 2 }

#[derive(Serialize, Debug)]
struct SearchResult {
    file_path: String,
    line_number: usize,
    line_content: String,
    context_before: Vec<String>,
    context_after: Vec<String>,
    /// Byte offset of the match within the untrimmed line.
    match_column: usize,
}

#[derive(Serialize, Debug)]
struct Output {
    status: String,
    result: Option<Vec<SearchResult>>,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,  // 是否被截断
    /// Total matches found before `max_results` truncation. Without it a caller
    /// that received a truncated page cannot tell how much it is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

struct AppConfig {
    max_results: usize,
    ignored_folders: HashSet<String>,
    allowed_extensions: HashSet<String>,
}

impl AppConfig {
    fn from_env() -> Self {
        let max_results = env::var("MAX_RESULTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_MAX_RESULTS);

        let ignored_folders = env::var("IGNORED_FOLDERS")
            .unwrap_or_else(|_| "target,.git,node_modules,dist,build".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // Extensions are compared lowercased, so `.JS` on a case-insensitive
        // filesystem is not silently skipped.
        let allowed_extensions = env::var("ALLOWED_EXTENSIONS")
            .unwrap_or_else(|_| "rs,toml,md,txt,js,ts,py,java,go,yml,yaml,json".to_string())
            .split(',')
            .map(|s| s.trim().trim_start_matches('.').to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        AppConfig {
            max_results,
            ignored_folders,
            allowed_extensions,
        }
    }
}

fn find_project_root() -> PathBuf {
    // Start from the current working directory
    if let Ok(mut path) = env::current_dir() {
        // Search up to 5 levels for common project markers
        for _ in 0..5 {
            if path.join(".git").is_dir()
                || path.join("package.json").is_file()
                || path.join("Cargo.toml").is_file()
            {
                return path;
            }
            if !path.pop() {
                // We've reached the root and can't go up further
                break;
            }
        }
    }
    // Fallback to the current directory if no project root is found or if getting CWD failed
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() {
    let mut buffer = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buffer) {
        print_error(format!("Failed to read stdin: {}", e));
        return;
    }

    let args: InputArgs = match serde_json::from_str(&buffer) {
        Ok(args) => args,
        Err(e) => {
            print_error(format!("Invalid JSON: {}", e));
            return;
        }
    };

    let config = AppConfig::from_env();
    
    let regex = match build_regex(&args) {
        Ok(re) => re,
        Err(e) => {
            print_error(format!("Invalid regex: {}", e));
            return;
        }
    };

    let base_path = match args.base_path.as_ref() {
        Some(p) => PathBuf::from(p),
        None => find_project_root(),
    };
    
    let search_root = match args.search_path.as_ref() {
        Some(p) => {
            let candidate = Path::new(p);
            if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                base_path.join(candidate)
            }
        }
        None => base_path.clone(),
    };

    if !search_root.exists() {
        print_error(format!("search_path does not exist: {}", search_root.display()));
        return;
    }

    match search_in_directory(&search_root, &regex, &config, &args, &base_path) {
        Ok((results, truncated, total)) => {
            let output = Output {
                status: "success".to_string(),
                result: Some(results),
                error: None,
                truncated: if truncated { Some(true) } else { None },
                total: Some(total),
            };
            if let Ok(json) = serde_json::to_string(&output) {
                println!("{}", json);
            }
        }
        Err(e) => print_error(format!("Search failed: {}", e)),
    }
}

fn build_regex(args: &InputArgs) -> Result<Regex, regex::Error> {
    let mut pattern = if args.is_regex {
        args.query.clone()
    } else {
        regex::escape(&args.query)
    };

    if args.whole_word {
        pattern = format!(r"\b{}\b", pattern);
    }

    let pattern = if args.case_sensitive {
        pattern
    } else {
        format!("(?i){}", pattern)
    };

    Regex::new(&pattern)
}

/// Whether one walked entry lies inside an ignored directory.
///
/// This replaces `WalkBuilder::add_ignore(folder_name)`, which the original
/// used for `IGNORED_FOLDERS`: that method registers an ignore FILE (a
/// `.gitignore`-shaped file) to read patterns from, so a bare directory name
/// silently matched nothing and every "ignored" folder was still searched.
/// Pruning here happens during the walk, so an ignored subtree is never
/// descended into rather than being filtered out of the results afterwards.
fn is_ignored(entry: &DirEntry, ignored_folders: &HashSet<String>) -> bool {
    if ignored_folders.is_empty() {
        return false;
    }
    // The walk root itself must never be pruned: a caller that deliberately
    // points `search_path` at `.../node_modules/express` asked for it.
    if entry.depth() == 0 {
        return false;
    }
    let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
    if !is_dir {
        return false;
    }
    entry
        .file_name()
        .to_str()
        .map(|name| ignored_folders.contains(name))
        .unwrap_or(false)
}

fn search_in_directory(
    path: &Path,
    query_regex: &Regex,
    config: &AppConfig,
    args: &InputArgs,
    project_base: &Path,
) -> Result<(Vec<SearchResult>, bool, usize), io::Error> {
    let mut walk_builder = WalkBuilder::new(path);
    walk_builder.hidden(false).git_ignore(true).max_filesize(Some(MAX_FILE_SIZE));

    let ignored_folders = config.ignored_folders.clone();
    walk_builder.filter_entry(move |entry| !is_ignored(entry, &ignored_folders));

    let (tx, rx) = mpsc::channel();
    let query_regex = query_regex.clone();
    let project_base_buf = project_base.to_path_buf();
    let allowed_extensions = config.allowed_extensions.clone();
    let context_lines = args.context_lines;

    walk_builder.build_parallel().run(move || {
        let tx = tx.clone();
        let query_regex = query_regex.clone();
        let project_base = project_base_buf.clone();
        let allowed_extensions = allowed_extensions.clone();

        Box::new(move |entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return WalkState::Continue,
            };

            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }

            let file_path = entry.path();
            if !allowed_extensions.is_empty() {
                if let Some(ext) = file_path.extension().and_then(|s| s.to_str()) {
                    if !allowed_extensions.contains(&ext.to_lowercase()) {
                        return WalkState::Continue;
                    }
                } else {
                    return WalkState::Continue;
                }
            }

            if let Ok(content) = fs::read_to_string(file_path) {
                let file_results = search_in_content(
                    &content,
                    &query_regex,
                    file_path,
                    &project_base,
                    context_lines,
                );
                if !file_results.is_empty() {
                    let _ = tx.send(file_results);
                }
            }
            WalkState::Continue
        })
    });

    let mut results: Vec<SearchResult> = rx.into_iter().flatten().collect();

    // The parallel walk completes files in nondeterministic order, so without
    // this the truncated page was an arbitrary sample that changed between
    // identical calls. Sorting first makes `max_results` mean "the first N in
    // file order" and makes repeated searches reproducible.
    results.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.line_number.cmp(&b.line_number))
            .then(a.match_column.cmp(&b.match_column))
    });

    let total = results.len();
    let truncated = if total > config.max_results {
        results.truncate(config.max_results);
        true
    } else {
        false
    };

    Ok((results, truncated, total))
}

fn search_in_content(
    content: &str,
    regex: &Regex,
    file_path: &Path,
    project_base: &Path,
    context_lines: usize,
) -> Vec<SearchResult> {
    let lines: Vec<&str> = content.lines().collect();
    let mut results = Vec::new();
    
    let relative_path = pathdiff::diff_paths(file_path, project_base)
        .unwrap_or_else(|| file_path.to_path_buf());

    for (i, line) in lines.iter().enumerate() {
        if let Some(mat) = regex.find(line) {
            let context_before = if i >= context_lines {
                lines[i.saturating_sub(context_lines)..i]
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            } else {
                lines[0..i].iter().map(|s| s.to_string()).collect()
            };

            let end = std::cmp::min(i + 1 + context_lines, lines.len());
            let context_after = lines[i + 1..end]
                .iter()
                .map(|s| s.to_string())
                .collect();

            results.push(SearchResult {
                file_path: relative_path.to_string_lossy().into_owned(),
                line_number: i + 1,
                line_content: line.trim().to_string(),
                context_before,
                context_after,
                match_column: mat.start(),
            });
        }
    }

    results
}

fn print_error(message: String) {
    let output = Output {
        status: "error".to_string(),
        result: None,
        error: Some(message),
        truncated: None,
        total: None,
    };
    if let Ok(json) = serde_json::to_string(&output) {
        println!("{}", json);
    }
}
