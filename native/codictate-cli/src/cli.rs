//! The command grammar of docs/CLI.md "Commands", and the requests it turns into.

use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};

use crate::caller::Caller;
use crate::failure::{CONTRACT_VERSION, Failure};

#[derive(Parser, Debug)]
#[command(
    name = "codictate",
    bin_name = "codictate",
    about = "Codictate's command line: transcribe files, dictate, and manage Speech Models.",
    long_about = "Codictate's command line: transcribe files, dictate, and manage Speech Models.\n\n\
        Every command goes through the Codictate app this client ships in. When the app is \
        not running it is started hidden, without a window.",
    disable_version_flag = true,
    arg_required_else_help = true,
    args_conflicts_with_subcommands = true
)]
pub struct Cli {
    /// Print the version and exit
    #[arg(short = 'V', long = "version")]
    pub version: bool,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug, Clone, PartialEq)]
pub enum Command {
    /// Transcribe audio or video files with the File Transcription Settings
    Transcribe(TranscribeArgs),
    /// Record a Dictation from the microphone and print its text
    Dictate(DictateArgs),
    /// End whichever Dictation is running
    Stop(JsonFlag),
    /// Show what Codictate is doing and how it is set up
    Status(JsonFlag),
    /// List, select, download and remove Speech Models
    #[command(subcommand_required = true, arg_required_else_help = true)]
    Models {
        #[command(subcommand)]
        command: ModelsCommand,
    },
    /// List and select Transcription Languages
    #[command(subcommand_required = true, arg_required_else_help = true)]
    Languages {
        #[command(subcommand)]
        command: LanguagesCommand,
    },
}

#[derive(Args, Debug, Clone, PartialEq)]
pub struct JsonFlag {
    /// Print every event as one JSON object per line (NDJSON)
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, PartialEq)]
pub struct TranscribeArgs {
    /// Audio or video files, transcribed one after another
    #[arg(required = true, value_name = "FILE")]
    pub files: Vec<PathBuf>,

    /// Use this installed Speech Model for this call only
    #[arg(long, value_name = "ID")]
    pub model: Option<String>,

    /// Transcription Language for this call only
    #[arg(long, value_name = "ID|auto")]
    pub language: Option<String>,

    /// Translate to English for this call, whatever the File Transcription Settings say
    #[arg(long, conflicts_with = "no_translate")]
    pub translate: bool,

    /// Do not translate for this call, whatever the File Transcription Settings say
    #[arg(long = "no-translate")]
    pub no_translate: bool,

    /// Print the transcript as text, as captions (SRT or VTT) or as JSON
    #[arg(long, value_enum, value_name = "FORMAT")]
    pub format: Option<Format>,

    /// Write the transcript to this file instead of printing it (one file only)
    #[arg(short = 'o', long = "output", value_name = "PATH")]
    pub output_file: Option<PathBuf>,

    #[command(flatten)]
    pub output: JsonFlag,
}

/// A Transcript Export format (docs/CLI.md "Captions and JSON").
#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// The transcript as plain text
    Txt,
    /// SubRip captions
    Srt,
    /// WebVTT captions
    Vtt,
    /// The transcript and what it was made with, as JSON
    Json,
}

impl Format {
    fn wire(self) -> &'static str {
        match self {
            Format::Txt => "txt",
            Format::Srt => "srt",
            Format::Vtt => "vtt",
            Format::Json => "json",
        }
    }
}

impl TranscribeArgs {
    /// `true` / `false` force Translate to English; `null` leaves it to the settings.
    fn translate_wire(&self) -> Value {
        match (self.translate, self.no_translate) {
            (true, _) => json!(true),
            (_, true) => json!(false),
            _ => Value::Null,
        }
    }
}

#[derive(Args, Debug, Clone, PartialEq)]
pub struct DictateArgs {
    /// Place the text at the cursor instead of printing it
    #[arg(long)]
    pub paste: bool,

    /// Skip the Dictionary and the Formatting Mode
    #[arg(long)]
    pub raw: bool,

    /// What ends the recording besides Ctrl-C and `codictate stop`
    #[arg(long, value_enum, default_value_t = Until::Enter)]
    pub until: Until,

    /// End the recording after this many seconds
    #[arg(long, value_name = "SECONDS", value_parser = parse_seconds)]
    pub max: Option<f64>,

    /// Use this installed Speech Model for this Dictation only
    #[arg(long, value_name = "ID")]
    pub model: Option<String>,

    /// Transcription Language for this Dictation only
    #[arg(long, value_name = "ID|auto")]
    pub language: Option<String>,

    /// Use this Formatting Mode for this Dictation only
    #[arg(long = "formatting-mode", value_name = "ID")]
    pub formatting_mode: Option<String>,

    #[command(flatten)]
    pub output: JsonFlag,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Until {
    /// Enter or the first Ctrl-C
    Enter,
    /// Also a pause in speech
    Silence,
}

impl Until {
    fn wire(self) -> &'static str {
        match self {
            Until::Enter => "enter",
            Until::Silence => "silence",
        }
    }
}

#[derive(Subcommand, Debug, Clone, PartialEq)]
pub enum ModelsCommand {
    /// Show the curated Speech Models plus any installed one
    List {
        /// Show every Speech Model
        #[arg(long)]
        all: bool,
        #[command(flatten)]
        output: JsonFlag,
    },
    /// Select a Speech Model, exactly as Settings does
    Use {
        #[arg(value_name = "ID")]
        id: String,
        #[command(flatten)]
        output: JsonFlag,
    },
    /// Download a Speech Model, without selecting it
    Download {
        #[arg(value_name = "ID")]
        id: String,
        #[command(flatten)]
        output: JsonFlag,
    },
    /// Remove a Speech Model's weights
    Remove {
        #[arg(value_name = "ID")]
        id: String,
        #[command(flatten)]
        output: JsonFlag,
    },
}

#[derive(Subcommand, Debug, Clone, PartialEq)]
pub enum LanguagesCommand {
    /// Show every Transcription Language and whether the selected Speech Model allows it
    List {
        #[command(flatten)]
        output: JsonFlag,
    },
    /// Select a Transcription Language
    Use {
        #[arg(value_name = "ID|auto")]
        id: String,
        #[command(flatten)]
        output: JsonFlag,
    },
}

fn parse_seconds(raw: &str) -> Result<f64, String> {
    match raw.parse::<f64>() {
        Ok(seconds) if seconds.is_finite() && seconds > 0.0 => Ok(seconds),
        _ => Err(format!("'{raw}' is not a positive number of seconds")),
    }
}

/// What the human rendering of a result depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Transcribe,
    Dictate { paste: bool },
    Stop,
    Status,
    ModelsList,
    ModelsUse,
    ModelsDownload,
    ModelsRemove,
    LanguagesList,
    LanguagesUse,
}

/// One connection: one request line, one `result` or `error`.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    /// The file as the user typed it, for `transcribe`.
    pub label: Option<String>,
    pub request: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub kind: Kind,
    pub json: bool,
    pub jobs: Vec<Job>,
    /// `transcribe -o`: the client writes the transcript here instead of printing it.
    pub output_file: Option<PathBuf>,
    /// `transcribe --format`: the result must carry `formatted`.
    pub wants_formatted: bool,
}

pub fn request(command: &str, args: Value, caller: &Caller) -> Value {
    json!({
        "contractVersion": CONTRACT_VERSION,
        "command": command,
        "args": args,
        "caller": {"name": caller.name, "pid": caller.pid},
    })
}

/// Resolves a file argument against the working directory, as the app needs an absolute path.
pub fn absolute_file(file: &Path, cwd: &Path) -> Result<String, Failure> {
    let joined = if file.is_absolute() {
        file.to_path_buf()
    } else {
        cwd.join(file)
    };
    let absolute = std::path::absolute(&joined).unwrap_or(joined);
    absolute
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| Failure::usage(format!("{} is not a UTF-8 path", file.display())))
}

pub fn plan(command: Command, caller: &Caller, cwd: &Path) -> Result<Plan, Failure> {
    let single = |kind: Kind, json: bool, name: &str, args: Value| Plan {
        kind,
        json,
        jobs: vec![Job {
            label: None,
            request: request(name, args, caller),
        }],
        output_file: None,
        wants_formatted: false,
    };
    Ok(match command {
        Command::Transcribe(args) => {
            if args.output_file.is_some() && args.files.len() > 1 {
                return Err(Failure::usage(format!(
                    "--output takes one file, but {} were given (see 'codictate --help')",
                    args.files.len()
                )));
            }
            let translate = args.translate_wire();
            let format = args.format.map(Format::wire);
            let mut jobs = Vec::with_capacity(args.files.len());
            for file in &args.files {
                let absolute = absolute_file(file, cwd)?;
                jobs.push(Job {
                    label: Some(file.display().to_string()),
                    request: request(
                        "transcribe",
                        json!({
                            "file": absolute,
                            "speechModelId": args.model,
                            "languageId": args.language,
                            "translate": translate,
                            "format": format,
                        }),
                        caller,
                    ),
                });
            }
            Plan {
                kind: Kind::Transcribe,
                json: args.output.json,
                jobs,
                output_file: args.output_file,
                wants_formatted: args.format.is_some(),
            }
        }
        Command::Dictate(args) => single(
            Kind::Dictate { paste: args.paste },
            args.output.json,
            "dictate",
            json!({
                "output": if args.paste { "cursor" } else { "stdout" },
                "raw": args.raw,
                "until": args.until.wire(),
                "maxSeconds": args.max,
                "speechModelId": args.model,
                "languageId": args.language,
                "formattingModeId": args.formatting_mode,
            }),
        ),
        Command::Stop(flag) => single(Kind::Stop, flag.json, "stop", json!({})),
        Command::Status(flag) => single(Kind::Status, flag.json, "status", json!({})),
        Command::Models { command } => match command {
            ModelsCommand::List { all, output } => single(
                Kind::ModelsList,
                output.json,
                "models.list",
                json!({"all": all}),
            ),
            ModelsCommand::Use { id, output } => single(
                Kind::ModelsUse,
                output.json,
                "models.use",
                json!({"id": id}),
            ),
            ModelsCommand::Download { id, output } => single(
                Kind::ModelsDownload,
                output.json,
                "models.download",
                json!({"id": id}),
            ),
            ModelsCommand::Remove { id, output } => single(
                Kind::ModelsRemove,
                output.json,
                "models.remove",
                json!({"id": id}),
            ),
        },
        Command::Languages { command } => match command {
            LanguagesCommand::List { output } => single(
                Kind::LanguagesList,
                output.json,
                "languages.list",
                json!({}),
            ),
            LanguagesCommand::Use { id, output } => single(
                Kind::LanguagesUse,
                output.json,
                "languages.use",
                json!({"id": id}),
            ),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("codictate").chain(args.iter().copied()))
    }

    fn command(args: &[&str]) -> Command {
        parse(args).unwrap().command.unwrap()
    }

    fn caller() -> Caller {
        Caller {
            name: "Terminal".into(),
            pid: 4211,
        }
    }

    fn cwd() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\work")
        } else {
            PathBuf::from("/work")
        }
    }

    fn plan_of(args: &[&str]) -> Result<Plan, Failure> {
        plan(command(args), &caller(), &cwd())
    }

    fn planned(args: &[&str]) -> Plan {
        plan_of(args).unwrap()
    }

    #[test]
    fn version_needs_no_command() {
        let cli = parse(&["--version"]).unwrap();
        assert!(cli.version);
        assert!(cli.command.is_none());
        assert!(parse(&["-V"]).unwrap().version);
    }

    #[test]
    fn no_arguments_shows_help_as_a_usage_error() {
        let err = parse(&[]).unwrap_err();
        assert_eq!(
            err.kind(),
            ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        );
    }

    #[test]
    fn per_command_help_is_help() {
        for args in [
            &["--help"][..],
            &["transcribe", "--help"],
            &["dictate", "--help"],
            &["models", "download", "--help"],
            &["languages", "use", "--help"],
        ] {
            assert_eq!(parse(args).unwrap_err().kind(), ErrorKind::DisplayHelp);
        }
    }

    #[test]
    fn models_without_a_subcommand_is_rejected() {
        assert!(parse(&["models"]).is_err());
        assert!(parse(&["languages"]).is_err());
    }

    #[test]
    fn transcribe_needs_a_file() {
        assert_eq!(
            parse(&["transcribe"]).unwrap_err().kind(),
            ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn unknown_flags_are_usage_errors() {
        assert_eq!(
            parse(&["status", "--verbose"]).unwrap_err().kind(),
            ErrorKind::UnknownArgument
        );
        assert!(parse(&["dictate", "--until", "never"]).is_err());
        assert!(parse(&["dictate", "--max", "0"]).is_err());
        assert!(parse(&["dictate", "--max", "-3"]).is_err());
        assert!(parse(&["dictate", "--max", "soon"]).is_err());
    }

    #[test]
    fn transcribe_parses_every_flag() {
        assert_eq!(
            command(&[
                "transcribe",
                "a.m4a",
                "b.mov",
                "--model",
                "large-v3-q5_0",
                "--language",
                "auto",
                "--json"
            ]),
            Command::Transcribe(TranscribeArgs {
                files: vec!["a.m4a".into(), "b.mov".into()],
                model: Some("large-v3-q5_0".into()),
                language: Some("auto".into()),
                translate: false,
                no_translate: false,
                format: None,
                output_file: None,
                output: JsonFlag { json: true },
            })
        );
        assert_eq!(
            command(&[
                "transcribe",
                "a.m4a",
                "--translate",
                "--format",
                "srt",
                "-o",
                "a.srt"
            ]),
            Command::Transcribe(TranscribeArgs {
                files: vec!["a.m4a".into()],
                model: None,
                language: None,
                translate: true,
                no_translate: false,
                format: Some(Format::Srt),
                output_file: Some("a.srt".into()),
                output: JsonFlag { json: false },
            })
        );
        let Command::Transcribe(long) =
            command(&["transcribe", "a.m4a", "--no-translate", "--output", "a.txt"])
        else {
            panic!("expected transcribe");
        };
        assert!(long.no_translate && !long.translate);
        assert_eq!(long.output_file, Some(PathBuf::from("a.txt")));
    }

    #[test]
    fn transcribe_rejects_contradictions_and_unknown_formats() {
        assert_eq!(
            parse(&["transcribe", "a", "--translate", "--no-translate"])
                .unwrap_err()
                .kind(),
            ErrorKind::ArgumentConflict
        );
        assert!(parse(&["transcribe", "a", "--format", "docx"]).is_err());
        assert!(parse(&["transcribe", "a", "--format", "SRT"]).is_err());
        assert!(parse(&["transcribe", "a", "-o"]).is_err());
    }

    #[test]
    fn transcribe_translate_is_null_unless_a_flag_says() {
        for (flags, expected) in [
            (&[][..], Value::Null),
            (&["--translate"][..], json!(true)),
            (&["--no-translate"][..], json!(false)),
        ] {
            let mut args = vec!["transcribe", "/a"];
            args.extend_from_slice(flags);
            assert_eq!(
                planned(&args).jobs[0].request["args"]["translate"],
                expected
            );
        }
    }

    #[test]
    fn transcribe_format_goes_on_the_wire_and_the_plan_wants_it_back() {
        let plain = planned(&["transcribe", "/a"]);
        assert_eq!(plain.jobs[0].request["args"]["format"], Value::Null);
        assert!(!plain.wants_formatted);
        for (flag, wire) in [
            ("txt", "txt"),
            ("srt", "srt"),
            ("vtt", "vtt"),
            ("json", "json"),
        ] {
            let plan = planned(&["transcribe", "/a", "/b", "--format", flag]);
            assert!(plan.wants_formatted);
            for job in &plan.jobs {
                assert_eq!(job.request["args"]["format"], wire);
            }
        }
    }

    #[test]
    fn output_takes_one_file() {
        let plan = planned(&["transcribe", "memo.m4a", "-o", "memo.srt"]);
        assert_eq!(plan.output_file, Some(PathBuf::from("memo.srt")));
        let err = plan_of(&["transcribe", "a.m4a", "b.m4a", "-o", "out.txt"]).unwrap_err();
        assert_eq!(err.code, "usage");
        assert_eq!(err.exit, 2);
        assert_eq!(
            err.message,
            "--output takes one file, but 2 were given (see 'codictate --help')"
        );
        assert_eq!(planned(&["status"]).output_file, None);
    }

    #[test]
    fn dictate_defaults() {
        assert_eq!(
            command(&["dictate"]),
            Command::Dictate(DictateArgs {
                paste: false,
                raw: false,
                until: Until::Enter,
                max: None,
                model: None,
                language: None,
                formatting_mode: None,
                output: JsonFlag { json: false },
            })
        );
    }

    #[test]
    fn the_request_line_matches_the_documented_shape() {
        let file = if cfg!(windows) {
            r"C:\abs\path\memo.m4a"
        } else {
            "/abs/path/memo.m4a"
        };
        let plan = planned(&["transcribe", file]);
        let mut expected: Value =
            serde_json::from_str(include_str!("../tests/fixtures/request-transcribe.json"))
                .unwrap();
        expected["args"]["file"] = json!(file);
        assert_eq!(plan.jobs.len(), 1);
        assert_eq!(plan.jobs[0].request, expected);
    }

    #[test]
    fn transcribe_resolves_relative_files_and_loops_over_them() {
        let plan = planned(&["transcribe", "memo.m4a", "./clips/b.mov"]);
        assert_eq!(plan.kind, Kind::Transcribe);
        assert!(!plan.json);
        let files: Vec<_> = plan
            .jobs
            .iter()
            .map(|job| job.request["args"]["file"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            files,
            vec![
                cwd().join("memo.m4a").display().to_string(),
                cwd().join("clips").join("b.mov").display().to_string(),
            ]
        );
        let labels: Vec<_> = plan.jobs.iter().map(|j| j.label.clone().unwrap()).collect();
        assert_eq!(labels, vec!["memo.m4a", "./clips/b.mov"]);
    }

    #[test]
    fn transcribe_overrides_go_in_every_request() {
        let plan = planned(&[
            "transcribe",
            "/a",
            "/b",
            "--model",
            "m",
            "--language",
            "da",
            "--translate",
        ]);
        for job in &plan.jobs {
            assert_eq!(job.request["command"], "transcribe");
            assert_eq!(job.request["args"]["speechModelId"], "m");
            assert_eq!(job.request["args"]["languageId"], "da");
            assert_eq!(job.request["args"]["translate"], true);
        }
    }

    #[test]
    fn dictate_request_without_flags() {
        let plan = planned(&["dictate"]);
        assert_eq!(plan.kind, Kind::Dictate { paste: false });
        assert_eq!(
            plan.jobs[0].request["args"],
            json!({
                "output": "stdout",
                "raw": false,
                "until": "enter",
                "maxSeconds": null,
                "speechModelId": null,
                "languageId": null,
                "formattingModeId": null,
            })
        );
    }

    #[test]
    fn dictate_request_with_every_flag() {
        let plan = planned(&[
            "dictate",
            "--paste",
            "--raw",
            "--until",
            "silence",
            "--max",
            "30",
            "--model",
            "parakeet-tdt-0.6b-v3",
            "--language",
            "da",
            "--formatting-mode",
            "email",
            "--json",
        ]);
        assert_eq!(plan.kind, Kind::Dictate { paste: true });
        assert!(plan.json);
        assert_eq!(
            plan.jobs[0].request["args"],
            json!({
                "output": "cursor",
                "raw": true,
                "until": "silence",
                "maxSeconds": 30.0,
                "speechModelId": "parakeet-tdt-0.6b-v3",
                "languageId": "da",
                "formattingModeId": "email",
            })
        );
    }

    #[test]
    fn every_command_name_and_args() {
        let cases: &[(&[&str], Kind, &str, Value)] = &[
            (&["stop"], Kind::Stop, "stop", json!({})),
            (&["status", "--json"], Kind::Status, "status", json!({})),
            (
                &["models", "list"],
                Kind::ModelsList,
                "models.list",
                json!({"all": false}),
            ),
            (
                &["models", "list", "--all"],
                Kind::ModelsList,
                "models.list",
                json!({"all": true}),
            ),
            (
                &["models", "use", "x"],
                Kind::ModelsUse,
                "models.use",
                json!({"id": "x"}),
            ),
            (
                &["models", "download", "x"],
                Kind::ModelsDownload,
                "models.download",
                json!({"id": "x"}),
            ),
            (
                &["models", "remove", "x"],
                Kind::ModelsRemove,
                "models.remove",
                json!({"id": "x"}),
            ),
            (
                &["languages", "list"],
                Kind::LanguagesList,
                "languages.list",
                json!({}),
            ),
            (
                &["languages", "use", "auto"],
                Kind::LanguagesUse,
                "languages.use",
                json!({"id": "auto"}),
            ),
        ];
        for (args, kind, name, wire_args) in cases {
            let plan = planned(args);
            assert_eq!(plan.kind, *kind, "{args:?}");
            assert_eq!(plan.jobs.len(), 1);
            let request = &plan.jobs[0].request;
            assert_eq!(request["contractVersion"], 1);
            assert_eq!(request["command"], *name, "{args:?}");
            assert_eq!(request["args"], *wire_args, "{args:?}");
            assert_eq!(request["caller"], json!({"name": "Terminal", "pid": 4211}));
        }
        assert!(planned(&["status", "--json"]).json);
        assert!(!planned(&["status"]).json);
    }
}
