// Phone numbers the way the server handles them (store.go).

/** A phone number as the server stores it (normalizePhone in store.go): 09121234567. */
export function normalizePhone(raw: string): string | null {
  let d = '';
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (ch >= '0' && ch <= '9') d += ch;
    else if (c >= 0x6f0 && c <= 0x6f9) d += String(c - 0x6f0); // Persian digits
    else if (c >= 0x660 && c <= 0x669) d += String(c - 0x660); // Arabic digits
    else if (!/[\s\-+()]/.test(ch)) return null;
  }
  if (d.startsWith('0098') && d.length === 14) d = '0' + d.slice(4);
  else if (d.startsWith('98') && d.length === 12) d = '0' + d.slice(2);
  else if (d.startsWith('9') && d.length === 10) d = '0' + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** An 11-digit mobile number (09123456789): what accounts are made with (isMobile in store.go). */
export const isMobile = (phone: string | null): phone is string => !!phone && phone.length === 11 && phone.startsWith('09');
