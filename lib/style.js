// Brand + text style for every message the bot sends (Telegram and WhatsApp).
//   Body text  -> bold italic:  Stain -> 𝑺𝒕𝒂𝒊𝒏
//   Brand name -> bold fraktur: Stain -> 𝕾𝖙𝖆𝖎𝖓
// Anything wrapped in {{ }} is left untouched (commands, codes, numbers) so it stays copyable.
const convert = (text, upper, lower) =>
  String(text).replace(/\{\{([\s\S]*?)\}\}|[A-Za-z]/g, (match, literal) => {
    if (literal !== undefined) return literal
    const c = match.charCodeAt(0)
    return String.fromCodePoint(c <= 90 ? upper + c - 65 : lower + c - 97)
  })

export const fancy = text => convert(text, 0x1d468, 0x1d482) // 𝑨 / 𝒂 (bold italic)
export const fraktur = text => convert(text, 0x1d56c, 0x1d586) // 𝕬 / 𝖆 (bold fraktur)

export const BRAND = 'ටි Stain Fun Bot'
export const brand = fraktur(BRAND)

// Bullet used in every list.
export const BULLET = '⊰'
export const bullets = lines => lines.map(line => `${BULLET} ${line}`).join('\n')
