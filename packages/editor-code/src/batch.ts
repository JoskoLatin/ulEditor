/**
 * Windows batch files.
 *
 * Written here because there is no mode for it anywhere — CodeMirror never had
 * one, and `@codemirror/legacy-modes` carries ninety-odd modes without a `.bat`
 * among them. On Windows this is the format an installer, a build step and half
 * the scripts in a repository are written in, so it opening as grey text is a
 * gap worth ten rules of regex.
 *
 * `simpleMode` rather than a hand-written tokeniser: batch has no grammar to
 * speak of — it is lines of commands with a handful of shapes — and a state
 * machine over regexes describes it honestly. What it cannot do is understand
 * the language, so this colours what is *lexically* certain and leaves the rest
 * alone. Better a plain word than a word painted the wrong colour.
 *
 * The three things worth knowing about batch, which the rules follow:
 *
 * - **`::` is not a comment**, it is a label that can never be jumped to, and
 *   people use it as one. `rem` is the real comment. Both are coloured as one
 *   because that is what they mean to a reader.
 * - **A variable has three spellings.** `%NAME%` is expansion at parse time,
 *   `!NAME!` at run time with delayed expansion on, and `%%i` is a loop counter
 *   inside a file — `%i` when the same line is typed at the prompt.
 * - **`^` escapes the next character**, including a newline, which is how a long
 *   command is wrapped. It is coloured as an operator so a trailing one at the
 *   end of a line is visible; an invisible line continuation is a classic way to
 *   lose an afternoon.
 */

import { StreamLanguage } from '@codemirror/language';
import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode';
import type { Extension } from '@codemirror/state';

/** Flow and the built-in statements of the interpreter itself. */
const KEYWORDS =
  /^(?:if|else|for|in|do|goto|call|exit|set|setlocal|endlocal|shift|pause|start|echo|title|color|cls|pushd|popd|verify|prompt|assoc|ftype)\b/i;

/** The words `if` tests with, and the comparison operators it accepts. */
const CONDITIONS = /^(?:not|defined|exist|errorlevel|equ|neq|lss|leq|gtr|geq)\b/i;

/** Commands that act on the machine rather than on the script. */
const COMMANDS =
  /^(?:cd|chdir|md|mkdir|rd|rmdir|del|erase|copy|xcopy|robocopy|move|ren|rename|type|more|find|findstr|sort|timeout|tasklist|taskkill|attrib|icacls|where|reg|sc|net|schtasks|powershell|pwsh|cmd|curl|tar|certutil|wmic|nvidia-smi)\b/i;

export const batch: Extension = StreamLanguage.define(
  simpleMode({
    start: [
      /*
       * `sol` — start of line only. A `::` in the middle of a line is not a
       * comment, and `rem` there is an argument to something else. The optional
       * `@` is the "do not echo this line" prefix, which belongs to the comment
       * it hides.
       */
      { regex: /\s*(?:@\s*)?(?:rem\b|::).*/i, token: 'comment', sol: true },

      /* A label, and the `goto :eof` that jumps to one. */
      { regex: /\s*:[A-Za-z0-9_.$-]+/, token: 'labelName', sol: true },
      { regex: /:[A-Za-z0-9_.$-]+/, token: 'labelName' },

      /* Unterminated strings are coloured too: batch does not require the
         closing quote, and leaving the rest of the line grey would suggest an
         error where there is none. */
      { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },

      { regex: /%%[A-Za-z]|%~?[\dA-Za-z_*][\w~$:.]*%?|![\w~$:.]+!/, token: 'variableName' },

      { regex: KEYWORDS, token: 'keyword' },
      { regex: CONDITIONS, token: 'operator' },
      { regex: COMMANDS, token: 'propertyName' },

      /* NUL, CON and the rest are devices, not files — worth telling apart from
         a name someone chose. */
      { regex: /\b(?:nul|con|prn|aux|com[1-9]|lpt[1-9])\b/i, token: 'builtin' },

      { regex: /\b\d+\b/, token: 'number' },

      /* `^` before the end of a line is a continuation. It matches here as an
         operator so it can be seen at all. */
      { regex: /\^.?|&&|\|\||[&|<>=+]+/, token: 'operator' },
    ],

    languageData: {
      commentTokens: { line: 'rem' },
    },
  }),
);
