// Microsoft Entra ID authorization hosts (public and sovereign clouds, plus the
// legacy login.windows.net alias).
const MICROSOFT_ENTRA_AUTHORIZATION_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.windows.net",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
]);

export function isMicrosoftEntraAuthorizationHost(hostname: string): boolean {
  return MICROSOFT_ENTRA_AUTHORIZATION_HOSTS.has(hostname.toLowerCase());
}
