/**
 * Croatian letters folded for a search: č and ć to c, đ to d, š to s, ž to z,
 * capitals to capitals.
 *
 * So "jamcevina" finds "Jamčevina" (ADR 0009, use 1), typed on a keyboard
 * that hides the háček behind a long press. Only these ten letters: an `ä` or an
 * `é` is another language's letter and stays as it is, and other forms of a word
 * ("jamčevinu" from "jamcevina") are not a matter of letters at all.
 *
 * **One for one.** Each of the ten is one UTF-16 unit and becomes one, so a
 * folded text is exactly as long as the text it came from and a hit found at
 * an offset in the one is at the same offset in the other: the editor marks the
 * hit in its own text without a map between the two. That is also why nothing
 * is normalised here. A text that carries `c` followed by a combining háček
 * (U+030C) is folded only after the caller composes it (`normalize('NFC')`),
 * at the cost of its offsets.
 *
 * Case is left alone: whether "Jamčevina" matches "jamcevina" is the search's
 * own `caseSensitive`, not a matter of letters either.
 */

const FOLDED: Readonly<Record<string, string>> = {
  č: 'c',
  ć: 'c',
  đ: 'd',
  š: 's',
  ž: 'z',
  Č: 'C',
  Ć: 'C',
  Đ: 'D',
  Š: 'S',
  Ž: 'Z',
};

const CROATIAN = /[čćđšžČĆĐŠŽ]/g;

export function fold(text: string): string {
  return text.replace(CROATIAN, (letter) => FOLDED[letter] ?? letter);
}
