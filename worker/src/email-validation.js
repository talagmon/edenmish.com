// Public-order email validation.
//
// Uncommon but syntactically valid custom domains remain allowed. We block
// malformed addresses and high-confidence typos that would prevent Shopify
// checkout creation or receipt/tracking delivery.

const DOMAIN_FIXES = Object.freeze({
  'gmai.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmil.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.om': 'gmail.com',
  'gmail.net': 'gmail.com',
  'gmail.org': 'gmail.com',
  'gmailcom': 'gmail.com',
  'g.mail.com': 'gmail.com',
  'gmai.co': 'gmail.com',
  'gmai.il': 'gmail.com',
  'gmil.co': 'gmail.com',
  'gmal.co': 'gmail.com',
  'gnail.co': 'gmail.com',
  'gmaill.co': 'gmail.com',
  'gmial.co': 'gmail.com',
  'outlok.com': 'outlook.com',
  'outlock.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'outlook.cm': 'outlook.com',
  'outlok.co': 'outlook.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotnail.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmail.cm': 'hotmail.com',
  'hotmial.co': 'hotmail.com',
  'hotmai.co': 'hotmail.com',
  'yaho.com': 'yahoo.com',
  'yhaoo.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'yahoo.cm': 'yahoo.com',
  'iclod.com': 'icloud.com',
  'iclould.com': 'icloud.com',
  'iclod.co': 'icloud.com',
  'icloud.co': 'icloud.com',
});

// Conservative suffix corrections for unambiguous keyboard mistakes.
const DOMAIN_SUFFIX_FIXES = Object.freeze([
  ['.co.ik', '.co.il'],
  ['.con', '.com'],
  ['.cim', '.com'],
  ['.cmo', '.com'],
  ['.comm', '.com'],
  ['.ogr', '.org'],
  ['.ney', '.net'],
  ['.ner', '.net'],
  ['.ik', '.il'],
]);

export function suggestEmailDomain(domainValue) {
  const domain = String(domainValue || '').trim().toLowerCase();
  if (!domain) return null;
  if (DOMAIN_FIXES[domain]) return DOMAIN_FIXES[domain];

  for (const [mistypedSuffix, correctedSuffix] of DOMAIN_SUFFIX_FIXES) {
    if (domain.endsWith(mistypedSuffix) && domain.length > mistypedSuffix.length) {
      return domain.slice(0, -mistypedSuffix.length) + correctedSuffix;
    }
  }

  return null;
}

export function validateEmailAddress(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) {
    return { valid: false, code: 'invalid_email' };
  }

  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) {
    return { valid: false, code: 'invalid_email' };
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const validLocal = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
  if (
    local.length > 64
    || !validLocal.test(local)
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || domain.length > 253
  ) {
    return { valid: false, code: 'invalid_email' };
  }

  const labels = domain.split('.');
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    labels.length < 2
    || labels.some((label) => !validLabel.test(label))
    || labels.at(-1).length < 2
  ) {
    return { valid: false, code: 'invalid_email' };
  }

  const correctedDomain = suggestEmailDomain(domain);
  if (correctedDomain && correctedDomain !== domain) {
    return {
      valid: false,
      code: 'invalid_email_domain',
      suggestion: `${local}@${correctedDomain}`,
    };
  }

  return { valid: true, email };
}
