use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL};
use std::{net::Ipv6Addr, ptr::NonNull};
use url::{Host, Url};

type ProxyEntry = CFDictionary<CFString, CFType>;

#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C-unwind" {
    fn CFNetworkCopySystemProxySettings() -> Option<NonNull<CFDictionary>>;
    fn CFNetworkCopyProxiesForURL(
        url: &CFURL,
        settings: &CFDictionary,
    ) -> Option<NonNull<CFArray<ProxyEntry>>>;

    static kCFProxyTypeKey: Option<&'static CFString>;
    static kCFProxyHostNameKey: Option<&'static CFString>;
    static kCFProxyPortNumberKey: Option<&'static CFString>;
    static kCFProxyTypeHTTP: Option<&'static CFString>;
    static kCFProxyTypeHTTPS: Option<&'static CFString>;
}

pub(crate) fn https_proxy_url(target: &str) -> Option<Url> {
    let target = CFURL::from_string(None, &CFString::from_str(target), None)?;
    // SAFETY: Both CFNetwork Copy APIs transfer one retain. The second returns
    // an array of CF dictionaries with CFString keys and CFType values.
    let proxies = unsafe {
        let settings = CFRetained::from_raw(CFNetworkCopySystemProxySettings()?);
        CFRetained::from_raw(CFNetworkCopyProxiesForURL(&target, &settings)?)
    };

    // Respect CFNetwork's first choice, including direct routes and exclusions.
    // PAC and other proxy types are outside this static HTTP CONNECT path.
    let entry = proxies.get(0)?;
    // SAFETY: CFNetwork exports these process-lifetime CFString constants.
    let (type_key, host_key, port_key, http, https) = unsafe {
        (
            kCFProxyTypeKey?,
            kCFProxyHostNameKey?,
            kCFProxyPortNumberKey?,
            kCFProxyTypeHTTP?,
            kCFProxyTypeHTTPS?,
        )
    };
    let proxy_type = entry.get(type_key)?.downcast::<CFString>().ok()?;
    if &*proxy_type != http && &*proxy_type != https {
        return None;
    }
    let host = entry.get(host_key)?.downcast::<CFString>().ok()?.to_string();
    let port = entry.get(port_key)?.downcast::<CFNumber>().ok()?.as_i32()?;
    let port = u16::try_from(port).ok().filter(|port| *port != 0)?;
    let host = match host.parse::<Ipv6Addr>() {
        Ok(address) => Host::Ipv6(address),
        Err(_) => Host::parse(&host).ok()?,
    };
    // kCFProxyTypeHTTPS describes an HTTP proxy that tunnels HTTPS via CONNECT.
    Url::parse(&format!("http://{host}:{port}")).ok()
}
