// Context is a veto on grounded evidence, never a source of inferred size.
// These bounded lexicons cover common booking wording, not arbitrary semantics.
// Apply every language together: reply language is not the input language, and
// customers/transcribers can mix scripts. Never modify raw text or quote offsets.
const word = pattern => new RegExp(`(?:^|[^\\p{L}\\p{M}])(?:${pattern})(?=$|[^\\p{L}\\p{M}])`, 'iu');
const sizes = 'קטן|קטנה|בינוני|בינונית|גדול|גדולה|small|medium|large|big|petit|petite|moyen|moyenne|grand|grande|маленький|маленькая|небольшой|средний|средняя|большой|большая|صغير|صغيرة|متوسط|متوسطة|كبير|كبيرة';
const nouns = 'מעטפה|מעטפות|חבילה|חבילות|קופסה|קופסאות|מקרר|מפתחות|envelope|parcel|package|box|fridge|refrigerator|keys|enveloppe|colis|boîte|boite|réfrigérateur|clés|конверт|посылка|коробка|холодильник|ключи|ظرف|طرد|صندوق|ثلاجة|مفاتيح';
const size = word(sizes), noun = word(nouns), item = word(`${sizes}|${nouns}`);
const weight = word('ו?ב?משקל|ו?שוקל(?:ת|ים|ות)?|ו?כבד(?:ה|ים|ות)?|ק["״\'׳]?ג|קילו(?:גרם|גרמים)?|kg|kgs|kilograms?|kilos?|heavy|weighs?|weight|poids|lourd|lourde|кг|килограмм(?:а|ов)?|вес|тяжелый|тяжёлый|كغ|كجم|كيلو|كيلوغرام|وزن|ثقيل|ثقيلة');
// Dimensions and item counts cannot be silently removed from a size quote.
const dimensionWords = word('ס["״׳\']?מ|סנטימטר(?:ים)?|מידות|במידות|אורך|באורך|רוחב|ברוחב|גובה|בגובה|cm|centimeters?');
const dimensions = /[0-9٠-٩۰-۹]+(?:[.,][0-9٠-٩۰-۹]+)?\s*(?:[x×*]|על)\s*[0-9٠-٩۰-۹]+/iu;
const quantity = word('כמות|בכמות|כמויות|בכמויות');
const countedItem = /(?:^|[^\p{L}\p{M}\d])([0-9٠-٩۰-۹]+|שתי|שני|שתיים|שתים|שניים|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|כמה|מספר|הרבה|זוג)\s+(?:מעטפ(?:ה|ות)|חביל(?:ה|ות)|קופס(?:ה|אות))(?=$|[^\p{L}\p{M}])/giu;
const negative = word('לא|אין|איני|אינני|אינו|אינה|בלי|ללא|not|no|without|don[’\']t|isn[’\']t|non|pas|sans|aucun|aucune|нет|не|без|لا|ليس|ليست|بدون');
const correction = word('בעצם|סליחה|טעות|אולי|תיקון|אלא|actually|sorry|instead|maybe|correction|en fait|pardon|plutôt|peut-être|на самом деле|извините|вместо|может быть|исправление|بل|عفوا|تصحيح|ربما');
const separator = /[.!?؟;,،\n]/u;
const replacement = /(?:^|[^\p{L}\p{M}])(?:אלא|but|mais|но|بل)(?=$|[^\p{L}\p{M}])/iu;
const alternatives = /(?:^|[^\p{L}\p{M}])(?:או|or|ou|или|أو|او)(?=$|[^\p{L}\p{M}])/giu;
const tokens = text => [...text.matchAll(/[\p{L}\p{M}]+/gu)];
const nearbyItem = text => item.test(tokens(text).slice(0,4).map(m=>m[0]).join(' '));

export function sizeContextRejection(text, {start, end, contentsEnd = end}) {
  // Weight has no structured booking field: retain conservative rejection even
  // across punctuation, including units attached to Latin/Arabic digits.
  if (weight.test(text) || dimensionWords.test(text) || dimensions.test(text) || quantity.test(text)) return 'size_context_ambiguous';
  for (const match of text.matchAll(countedItem)) {
    if (match[1] !== '1') return 'size_context_ambiguous';
  }

  // An item alternative needs item wording on BOTH sides of the connector.
  // Schedule/contact alternatives must not invalidate an otherwise certain size.
  for (const match of text.matchAll(alternatives)) {
    const left = text.slice(0,match.index).split(separator).at(-1);
    const right = text.slice(match.index+match[0].length).split(separator)[0];
    if (nearbyItem(tokens(left).slice(-4).map(m=>m[0]).join(' ')) && nearbyItem(right)) return 'size_context_ambiguous';
  }

  const before = text.slice(0,start).split(separator).at(-1).split(replacement).at(-1);
  if (negative.test(before)) return 'quote_negated';

  const after = text.slice(contentsEnd);
  // An adjective quote can be followed by its own noun ("small envelope").
  // Consume that one adjacent word, or an adjacent adjective for a noun quote;
  // another size/item outside it is conflicting evidence, not safe to discard.
  let remaining = after;
  const adjacent = /^\s+([\p{L}\p{M}]+)(?=$|[^\p{L}\p{M}])/u.exec(remaining);
  const quoted = text.slice(start,end);
  if (contentsEnd === end && /^[\p{L}\p{M}]+$/u.test(quoted.trim()) && adjacent && ((!noun.test(quoted) && noun.test(adjacent[1])) || (!size.test(quoted) && size.test(adjacent[1])))) remaining=remaining.slice(adjacent[0].length);
  // A quote cannot stop before the contents clause or its continuation. Require
  // the model to quote the complete item phrase; the anchored item parser then
  // validates its contents. Never infer documents while dropping 'and batteries'.
  const continuation = remaining.replace(/^[\s.!?؟;,،–—:-]+/u, '');
  const bookingContinuation = /^(?:ו(?:מחר|היום|שמי|האיסוף|המסירה|באיסוף|במסירה|לאיסוף|למסירה|הכתובת|האימייל|בבקשה|תודה))(?=$|[^\p{L}\p{M}])/u.test(continuation);
  if (/^(?:עם|גם|ו?(?:ה?כולל(?:ת)?|ה?מכיל(?:ה)?|בתוכו|בתוכה)|ו[א-ת]+)(?=$|[^\p{L}\p{M}])/u.test(continuation) && !bookingContinuation) return 'size_context_ambiguous';
  if (/^[0-9٠-٩۰-۹]+(?:[.,][0-9٠-٩۰-۹]+)?\s*מטר(?:ים)?(?=$|[^\p{L}\p{M}])/u.test(continuation)) return 'size_context_ambiguous';
  // Punctuation doesn't make a spoken self-correction a new independent item.
  // Corrections conservatively veto item/negation evidence or no replacement.
  // This can still reject apologies followed by unrelated negative notes.
  const correctionMatch = correction.exec(remaining);
  if (correctionMatch) {
    const rest = remaining.slice(correctionMatch.index+correctionMatch[0].length);
    if (item.test(rest) || negative.test(rest) || !tokens(rest).length) return 'size_context_ambiguous';
  }

  const trailing = remaining.replace(/^[\s.!?؟;,،–—:-]+/u,'');
  const neg = negative.exec(trailing);
  if (neg?.index === 0) {
    const rest = trailing.slice(neg[0].length);
    if (!tokens(rest).length || nearbyItem(rest) || /^[\s]*[,،.!?؟]/u.test(rest)) return 'quote_negated';
  }
  if (/^[\s.!?؟;,،–—:-]*(?:אין\s+(?:לי|לנו)|(?:היא|הוא|זה|זו)\s+לא)(?=$|[^\p{L}\p{M}])/u.test(after)) return 'quote_negated';

  if (item.test(remaining)) return 'size_context_ambiguous';
  return null;
}
