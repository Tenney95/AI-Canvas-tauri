//! Manual Muse credentials: parse only, with no filesystem, browser or network access.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;
use tauri::webview::{cookie::time::OffsetDateTime, Cookie};

const NAMES: [&str; 3] = ["hatch_sess", "hatch_vml", "hatch_gw"];
const MAX_INPUT_BYTES: usize = 16 * 1024;
const MAX_VALUE_BYTES: usize = 4096;
const MAX_ENTRIES: usize = 64;
const MAX_STORED_BYTES: usize = 8192;
const INVALID: &str = "Muse Cookie 格式无效，请粘贴请求头、hatch_sess 值或 Cookie JSON";
const DUPLICATE: &str = "Muse Cookie 含重复字段，无法确认唯一登录会话";
const LIMIT: &str = "Muse Cookie 输入超过 16 KiB 或条目数量超过 64";
const SCOPE: &str = "Muse Cookie 必须属于 muse.ai 且路径为 /";
const EXPIRY: &str = "Muse Cookie 过期时间格式无效或相互冲突";

// Value's default map accepts duplicate keys. Reject ambiguity before selecting any credential.
struct CheckedJson(Value);
impl<'de> Deserialize<'de> for CheckedJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct CheckedVisitor;
        impl<'de> Visitor<'de> for CheckedVisitor {
            type Value = CheckedJson;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result { formatter.write_str("bounded cookie JSON") }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> { Ok(CheckedJson(Value::Bool(value))) }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> { Ok(CheckedJson(Value::Number(value.into()))) }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> { Ok(CheckedJson(Value::Number(value.into()))) }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Number::from_f64(value).map(|number| CheckedJson(Value::Number(number))).ok_or_else(|| E::custom(INVALID))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value.chars().any(char::is_control) { return Err(E::custom(INVALID)); }
                Ok(CheckedJson(Value::String(value.into())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> { self.visit_str(&value) }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(CheckedJson(Value::Null)) }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { self.visit_unit() }
            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<CheckedJson>()? {
                    if values.len() == MAX_ENTRIES { return Err(de::Error::custom(LIMIT)); }
                    values.push(value.0);
                }
                Ok(CheckedJson(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if key.chars().any(char::is_control) { return Err(de::Error::custom(INVALID)); }
                    if values.contains_key(&key) { return Err(de::Error::custom(DUPLICATE)); }
                    if values.len() == MAX_ENTRIES { return Err(de::Error::custom(LIMIT)); }
                    values.insert(key, map.next_value::<CheckedJson>()?.0);
                }
                Ok(CheckedJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(CheckedVisitor)
    }
}

fn expiry(value: &Value) -> Result<Option<OffsetDateTime>, String> {
    let seconds = value.as_f64().filter(|value| value.is_finite()).ok_or(EXPIRY)?;
    // Chromium uses -1 for a session cookie; missing expiry must never gain a synthetic lifetime.
    if seconds == -1.0 { return Ok(None); }
    if !(0.0..=253_402_300_799.0).contains(&seconds) { return Err(EXPIRY.into()); }
    OffsetDateTime::from_unix_timestamp(seconds.floor() as i64).map(Some).map_err(|_| EXPIRY.into())
}

fn validate_scope(record: &Map<String, Value>) -> Result<(), String> {
    if let Some(domain) = record.get("domain") {
        if !domain.as_str().is_some_and(|domain| domain.eq_ignore_ascii_case("muse.ai") || domain.eq_ignore_ascii_case(".muse.ai")) {
            return Err(SCOPE.into());
        }
    }
    if record.get("path").is_some_and(|path| path.as_str() != Some("/")) { return Err(SCOPE.into()); }
    Ok(())
}

fn add_cookie(cookies: &mut Vec<Cookie<'static>>, name: &str, value: &str, expires: Option<OffsetDateTime>) -> Result<(), String> {
    if !NAMES.contains(&name) { return Ok(()); }
    if cookies.iter().any(|cookie| cookie.name() == name) { return Err(DUPLICATE.into()); }
    // RFC 6265 cookie-octet: no quoting, whitespace, separators, escapes or control characters.
    if value.is_empty() || value.len() > MAX_VALUE_BYTES || !value.bytes().all(|byte| matches!(byte, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e)) {
        return Err("Muse Cookie 值为空、过长或含不允许的字符".into());
    }
    let mut cookie = Cookie::build((name.to_string(), value.to_string()))
        .domain(".muse.ai").path("/").secure(true).http_only(true).build();
    if let Some(expires) = expires { cookie.set_expires(expires); }
    cookies.push(cookie);
    Ok(())
}

fn parse_record(record: &Value, cookies: &mut Vec<Cookie<'static>>, expiries: Option<&Map<String, Value>>) -> Result<(), String> {
    let record = record.as_object().ok_or(INVALID)?;
    let name = record.get("name").and_then(Value::as_str).ok_or(INVALID)?;
    if !NAMES.contains(&name) { return Ok(()); }
    validate_scope(record)?;
    let value = record.get("value").and_then(Value::as_str).ok_or(INVALID)?;
    let mut expires = None;
    let mut expiry_seen = false;
    for supplied in [record.get("expirationDate"), record.get("expires"), expiries.and_then(|map| map.get(name))].into_iter().flatten() {
        let parsed = expiry(supplied)?;
        if expiry_seen && parsed != expires { return Err(EXPIRY.into()); }
        expires = parsed;
        expiry_seen = true;
    }
    if let Some(session) = record.get("session") {
        let session = session.as_bool().ok_or(EXPIRY)?;
        if session && expires.is_some() { return Err(EXPIRY.into()); }
    }
    add_cookie(cookies, name, value, expires)
}

fn parse_json(value: &Value, cookies: &mut Vec<Cookie<'static>>, expiries: Option<&Map<String, Value>>) -> Result<(), String> {
    if let Some(records) = value.as_array() {
        for record in records { parse_record(record, cookies, expiries)?; }
        return Ok(());
    }
    let object = value.as_object().ok_or(INVALID)?;
    if object.contains_key("name") { return parse_record(value, cookies, expiries); }
    if let Some(wrapped) = object.get("cookies") {
        if expiries.is_some() || NAMES.iter().any(|name| object.contains_key(*name)) { return Err(INVALID.into()); }
        let expiries = object.get("expires").map(|value| value.as_object().ok_or(INVALID)).transpose()?;
        if !wrapped.is_object() && !wrapped.is_array() { return Err(INVALID.into()); }
        // Only one wrapper is supported; never recursively reinterpret cookie values or options.
        if wrapped.as_object().is_some_and(|value| value.contains_key("cookies")) { return Err(INVALID.into()); }
        return parse_json(wrapped, cookies, expiries);
    }
    validate_scope(object)?;
    for name in NAMES {
        if let Some(value) = object.get(name) {
            let value = value.as_str().ok_or(INVALID)?;
            let expires = expiries.and_then(|map| map.get(name)).map(expiry).transpose()?.flatten();
            add_cookie(cookies, name, value, expires)?;
        }
    }
    Ok(())
}

/// Accept a request Cookie header, a bare hatch_sess value, Chrome JSON, or muse2api's export.
pub(super) fn parse_manual_cookies(input: &str) -> Result<Vec<Cookie<'static>>, String> {
    if input.len() > MAX_INPUT_BYTES { return Err(LIMIT.into()); }
    let text = input.trim();
    if text.is_empty() { return Err(INVALID.into()); }
    let mut cookies = Vec::new();
    if text.starts_with('{') || text.starts_with('[') {
        let value = serde_json::from_str::<CheckedJson>(text).map_err(|_| INVALID)?.0;
        parse_json(&value, &mut cookies, None)?;
    } else {
        if input.chars().any(char::is_control) { return Err(INVALID.into()); }
        let prefixed = text.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("Cookie:"));
        let header = prefixed || text.contains(';') || NAMES.iter().any(|name| {
            text.strip_prefix(*name).is_some_and(|suffix| suffix.trim_start().starts_with('='))
        });
        if header {
            let header = if prefixed { text[7..].trim() } else { text };
            let mut entries = 0;
            for entry in header.split(';').map(str::trim).filter(|entry| !entry.is_empty()) {
                entries += 1;
                if entries > MAX_ENTRIES { return Err(LIMIT.into()); }
                let (name, value) = entry.split_once('=').ok_or(INVALID)?;
                add_cookie(&mut cookies, name.trim(), value.trim(), None)?;
            }
        } else {
            // Opaque values may contain '=' (including Base64 padding); do not split them.
            add_cookie(&mut cookies, "hatch_sess", text, None)?;
        }
    }
    if !cookies.iter().any(|cookie| cookie.name() == "hatch_sess") { return Err("Muse Cookie 缺少 hatch_sess".into()); }
    let values: Vec<String> = cookies.iter().map(ToString::to_string).collect();
    let serialized = serde_json::to_vec(&values).map_err(|_| INVALID)?;
    if serialized.len() > MAX_STORED_BYTES { return Err("Muse Cookie 总大小超过本机凭据上限，请仅保留必需登录字段".into()); }
    Ok(cookies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_headers_keep_only_muse_credentials_with_fixed_scope() {
        let cookies = parse_manual_cookies("Cookie: hatch_sess=fake-session==; analytics=ignored; hatch_vml=fake-vm; hatch_gw=fake-gateway").unwrap();
        assert_eq!(cookies.len(), 3);
        assert_eq!(cookies[0].value(), "fake-session==");
        for cookie in cookies {
            assert_eq!(cookie.domain(), Some("muse.ai"));
            assert_eq!(cookie.path(), Some("/"));
            assert_eq!(cookie.secure(), Some(true));
            assert_eq!(cookie.http_only(), Some(true));
            assert!(cookie.expires_datetime().is_none());
        }
    }

    #[test]
    fn opaque_values_preserve_equals_without_inventing_expiry() {
        for value in ["fake-session", "c3ludGhldGlj==", "opaque=value=="] {
            let cookies = parse_manual_cookies(value).unwrap();
            assert_eq!(cookies[0].name(), "hatch_sess");
            assert_eq!(cookies[0].value(), value);
            assert!(cookies[0].expires_datetime().is_none());
        }
    }

    #[test]
    fn chrome_json_preserves_expiry_and_overrides_unsafe_attributes() {
        let cookies = parse_manual_cookies("[\n {\"name\":\"hatch_sess\",\"value\":\"fake-session\",\"domain\":\".muse.ai\",\"path\":\"/\",\"secure\":false,\"httpOnly\":false,\"sameSite\":\"none\",\"expirationDate\":2000000000.9},\n {\"name\":\"unrelated\",\"value\":\"ignored\",\"domain\":\"example.com\"}\n]").unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].expires_datetime().unwrap().unix_timestamp(), 2_000_000_000);
        assert_eq!(cookies[0].secure(), Some(true));
        assert_eq!(cookies[0].http_only(), Some(true));
        assert!(cookies[0].same_site().is_none());
    }

    #[test]
    fn dictionaries_and_extension_exports_do_not_extend_real_expiry() {
        let dictionary = parse_manual_cookies(r#"{"hatch_sess":"fake-session","hatch_gw":"fake-gw","analytics":"ignored"}"#).unwrap();
        assert_eq!(dictionary.len(), 2);
        assert!(dictionary[0].expires_datetime().is_none());
        let exported = parse_manual_cookies(r#"{"cookies":{"hatch_sess":"fake-session","hatch_vml":"fake-vm"},"expires":{"hatch_sess":0,"hatch_vml":-1}}"#).unwrap();
        assert_eq!(exported[0].expires_datetime().unwrap().unix_timestamp(), 0);
        assert!(exported[1].expires_datetime().is_none());
    }

    #[test]
    fn duplicate_values_domains_and_conflicting_expiry_fail_closed() {
        for input in [
            "hatch_sess=fake-one; hatch_sess=fake-two",
            r#"{"hatch_sess":"fake-one","hatch_sess":"fake-two"}"#,
            r#"[{"name":"hatch_sess","value":"fake-one"},{"name":"hatch_sess","value":"fake-two"}]"#,
            r#"[{"name":"hatch_sess","value":"fake-session","domain":"evil-muse.ai"}]"#,
            r#"[{"name":"hatch_sess","value":"fake-session","domain":"sub.muse.ai"}]"#,
            r#"[{"name":"hatch_sess","value":"fake-session","path":"/other"}]"#,
            r#"[{"name":"hatch_sess","value":"fake-session","expirationDate":2000000000,"expires":2000000001}]"#,
            r#"[{"name":"hatch_sess","value":"fake-session","expirationDate":2000000000,"session":true}]"#,
            r#"{"hatch_sess":"fake-session","cookies":{"hatch_sess":"fake-other"}}"#,
        ] { assert!(parse_manual_cookies(input).is_err()); }
    }

    #[test]
    fn empty_missing_injected_or_malformed_input_never_echoes_values() {
        for input in [
            "", "hatch_sess=", "hatch_vml=fake-vm", "Cookie: analytics=ignored",
            "hatch_sess=fake-session\r\nX-Injected: value", "fake-session\n", "hatch_sess=fake\t-session",
            r#"{"hatch_sess":"fake\r\n-session"}"#,
            r#"{"hatch_sess":"fake-session","bad\nkey":"ignored"}"#,
            r#"{"hatch_sess":"fake-session","unrelated":"bad\u0000value"}"#,
            r#"{"hatch_sess":null}"#, r#"{"hatch_sess":42}"#, r#"{"hatch_sess":"fake-session""#,
        ] {
            let error = parse_manual_cookies(input).unwrap_err();
            assert!(!error.contains("fake-session"));
            assert!(!error.contains("Injected"));
        }
    }

    #[test]
    fn input_count_value_and_actual_secret_serialization_are_bounded() {
        assert!(parse_manual_cookies(&"a".repeat(MAX_INPUT_BYTES + 1)).is_err());
        assert!(parse_manual_cookies(&"a".repeat(MAX_VALUE_BYTES + 1)).is_err());
        let many = format!("hatch_sess=fake-session;{}", "ignored=one;".repeat(MAX_ENTRIES));
        assert!(parse_manual_cookies(&many).is_err());
        let too_large = format!("hatch_sess={}; hatch_vml={}", "a".repeat(4096), "b".repeat(4096));
        assert!(too_large.len() < MAX_INPUT_BYTES);
        assert!(parse_manual_cookies(&too_large).unwrap_err().contains("本机凭据上限"));
        let cookies = parse_manual_cookies(&format!("hatch_sess={}; hatch_vml={}", "a".repeat(3000), "b".repeat(3000))).unwrap();
        assert!(serde_json::to_vec(&cookies.iter().map(ToString::to_string).collect::<Vec<_>>()).unwrap().len() <= MAX_STORED_BYTES);
    }
}
