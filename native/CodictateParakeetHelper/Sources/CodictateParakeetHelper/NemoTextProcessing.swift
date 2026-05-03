import Foundation
import CNemoTextProcessing

/// Swift wrapper for NeMo Text Processing (Inverse Text Normalization).
///
/// Converts spoken-form ASR output to written form:
/// - "two hundred thirty two" → "232"
/// - "five dollars and fifty cents" → "$5.50"
/// - "january fifth twenty twenty five" → "January 5, 2025"
/// - "period" → "."
public enum NemoTextProcessing {

    // MARK: - Normalization

    /// Normalize spoken-form text to written form.
    ///
    /// Tries to match the entire input as a single expression.
    /// Use `normalizeSentence` for inputs containing mixed natural language and spoken forms.
    ///
    /// - Parameter input: Spoken-form text from ASR
    /// - Returns: Written-form text, or original if no normalization applies
    public static func normalize(_ input: String) -> String {
        guard let cString = input.cString(using: .utf8) else {
            return input
        }

        guard let resultPtr = nemo_normalize(cString) else {
            return input
        }

        defer { nemo_free_string(resultPtr) }

        return String(cString: resultPtr)
    }

    /// Normalize a full sentence, replacing spoken-form spans with written form.
    ///
    /// Scans for normalizable spans within a larger sentence using a sliding window.
    /// Uses a default max span of 16 tokens.
    ///
    /// - Parameter input: Sentence containing spoken-form spans
    /// - Returns: Sentence with spoken-form spans replaced
    ///
    /// Example:
    /// ```swift
    /// let result = NemoTextProcessing.normalizeSentence("I have twenty one apples")
    /// // result is "I have 21 apples"
    /// ```
    public static func normalizeSentence(_ input: String) -> String {
        guard let cString = input.cString(using: .utf8) else {
            return input
        }

        guard let resultPtr = nemo_normalize_sentence(cString) else {
            return input
        }

        defer { nemo_free_string(resultPtr) }

        return String(cString: resultPtr)
    }

    /// Normalize a full sentence with caller-specified options.
    ///
    /// - Parameters:
    ///   - input: Sentence containing spoken-form spans
    ///   - maxSpanTokens: Maximum consecutive tokens per normalizable span (0 = library default of 16)
    ///   - concatCompoundNumbers: When true, consecutive 0-99 number words concatenate
    ///     (aviation style — e.g. "thirty five sixty two" → "3562")
    ///   - disableBareSecond: When true, the bare word "second" is NOT rewritten to "2nd"
    /// - Returns: Sentence with spoken-form spans replaced
    public static func normalizeSentence(
        _ input: String,
        maxSpanTokens: UInt32 = 0,
        concatCompoundNumbers: Bool = false,
        disableBareSecond: Bool = false
    ) -> String {
        guard let cString = input.cString(using: .utf8) else {
            return input
        }

        guard let resultPtr = nemo_normalize_sentence_with_options(
            cString,
            concatCompoundNumbers ? 1 : 0,
            maxSpanTokens,
            disableBareSecond ? 1 : 0
        ) else {
            return input
        }

        defer { nemo_free_string(resultPtr) }

        return String(cString: resultPtr)
    }

    // MARK: - Text Normalization (Written → Spoken)

    /// Normalize written-form text to spoken form (TTS preprocessing).
    ///
    /// Tries to match the entire input as a single expression.
    /// Use `tnNormalizeSentence` for inputs containing mixed text.
    ///
    /// - Parameter input: Written-form text
    /// - Returns: Spoken-form text, or original if no normalization applies
    public static func tnNormalize(_ input: String) -> String {
        guard let cString = input.cString(using: .utf8) else {
            return input
        }
        guard let resultPtr = nemo_tn_normalize(cString) else {
            return input
        }
        defer { nemo_free_string(resultPtr) }
        return String(cString: resultPtr)
    }

    /// Normalize a full sentence, replacing written-form spans with spoken form.
    ///
    /// - Parameter input: Sentence containing written-form spans
    /// - Returns: Sentence with written-form spans replaced with spoken form
    ///
    /// Example:
    /// ```swift
    /// let result = NemoTextProcessing.tnNormalizeSentence("I paid $5 for 23 items")
    /// // result is "I paid five dollars for twenty three items"
    /// ```
    public static func tnNormalizeSentence(_ input: String) -> String {
        guard let cString = input.cString(using: .utf8) else {
            return input
        }
        guard let resultPtr = nemo_tn_normalize_sentence(cString) else {
            return input
        }
        defer { nemo_free_string(resultPtr) }
        return String(cString: resultPtr)
    }

    /// Normalize a full sentence with a configurable max span size.
    ///
    /// - Parameters:
    ///   - input: Sentence containing written-form spans
    ///   - maxSpanTokens: Maximum consecutive tokens per normalizable span (default 16)
    /// - Returns: Sentence with written-form spans replaced with spoken form
    public static func tnNormalizeSentence(_ input: String, maxSpanTokens: UInt32) -> String {
        guard let cString = input.cString(using: .utf8) else {
            return input
        }
        guard let resultPtr = nemo_tn_normalize_sentence_with_max_span(cString, maxSpanTokens) else {
            return input
        }
        defer { nemo_free_string(resultPtr) }
        return String(cString: resultPtr)
    }

    // MARK: - Language-Specific Text Normalization

    /// Normalize written-form text to spoken form for a specific language.
    ///
    /// Supported languages: "en", "fr", "es", "de", "zh", "hi", "ja".
    /// Falls back to English for unrecognized language codes.
    ///
    /// - Parameters:
    ///   - input: Written-form text
    ///   - language: ISO 639-1 language code
    /// - Returns: Spoken-form text, or original if no normalization applies
    ///
    /// Example:
    /// ```swift
    /// let result = NemoTextProcessing.tnNormalize("123", language: "fr")
    /// // result is "cent vingt-trois"
    /// ```
    public static func tnNormalize(_ input: String, language: String) -> String {
        guard let inputC = input.cString(using: .utf8),
              let langC = language.cString(using: .utf8) else {
            return input
        }
        guard let resultPtr = nemo_tn_normalize_lang(inputC, langC) else {
            return input
        }
        defer { nemo_free_string(resultPtr) }
        return String(cString: resultPtr)
    }

    /// Normalize a full sentence for a specific language, replacing written-form spans with spoken form.
    ///
    /// - Parameters:
    ///   - input: Sentence containing written-form spans
    ///   - language: ISO 639-1 language code
    /// - Returns: Sentence with written-form spans replaced with spoken form
    public static func tnNormalizeSentence(_ input: String, language: String) -> String {
        guard let inputC = input.cString(using: .utf8),
              let langC = language.cString(using: .utf8) else {
            return input
        }
        guard let resultPtr = nemo_tn_normalize_sentence_lang(inputC, langC) else {
            return input
        }
        defer { nemo_free_string(resultPtr) }
        return String(cString: resultPtr)
    }

    /// Normalize a full sentence for a specific language with a configurable max span size.
    ///
    /// - Parameters:
    ///   - input: Sentence containing written-form spans
    ///   - language: ISO 639-1 language code
    ///   - maxSpanTokens: Maximum consecutive tokens per normalizable span (default 16)
    /// - Returns: Sentence with written-form spans replaced with spoken form
    public static func tnNormalizeSentence(_ input: String, language: String, maxSpanTokens: UInt32) -> String {
        guard let inputC = input.cString(using: .utf8),
              let langC = language.cString(using: .utf8) else {
            return input
        }
        guard let resultPtr = nemo_tn_normalize_sentence_with_max_span_lang(inputC, langC, maxSpanTokens) else {
            return input
        }
        defer { nemo_free_string(resultPtr) }
        return String(cString: resultPtr)
    }

    // MARK: - Custom Rules

    /// Add a custom spoken→written normalization rule.
    ///
    /// Custom rules have the highest priority, checked before all built-in taggers.
    /// Matching is case-insensitive on the spoken form.
    /// If a rule with the same spoken form exists, it is replaced.
    ///
    /// - Parameters:
    ///   - spoken: The spoken form to match (e.g., "gee pee tee")
    ///   - written: The written replacement (e.g., "GPT")
    public static func addRule(spoken: String, written: String) {
        spoken.withCString { spokenPtr in
            written.withCString { writtenPtr in
                nemo_add_rule(spokenPtr, writtenPtr)
            }
        }
    }

    /// Remove a custom normalization rule.
    ///
    /// - Parameter spoken: The spoken form to remove
    /// - Returns: True if the rule was found and removed
    @discardableResult
    public static func removeRule(spoken: String) -> Bool {
        return spoken.withCString { spokenPtr in
            nemo_remove_rule(spokenPtr) != 0
        }
    }

    /// Clear all custom normalization rules.
    public static func clearRules() {
        nemo_clear_rules()
    }

    /// The number of custom rules currently registered.
    public static var ruleCount: Int {
        Int(nemo_rule_count())
    }

    // MARK: - Info

    /// Get the library version.
    public static var version: String {
        guard let versionPtr = nemo_version() else {
            return "unknown"
        }
        return String(cString: versionPtr)
    }
}
