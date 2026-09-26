/**
 * The SUMIFS/COUNTIFS cases Excel was asked, and what it answered.
 *
 * Shared by `verify-formula.mjs`, which holds this module to the answers, and
 * `verify-formula-excel.mjs`, which asks Excel again — so a case added here is
 * a case both run, and an answer copied wrong here is an answer Excel disputes.
 *
 * An entry is `[formula, what Excel 16 answered, what this module answers]`,
 * the third only where the two differ on purpose — `null`, a refusal.
 */

export const EXCEL_DATA = [
  [5, '5', 'Gotovina', 10, 0],
  [5, '5', 'gotovina', 20, null],
  [7, '7', 'K – kartice', 30, 1.5],
  [7, '7', 'K - kartice', 40, 0],
  [1, '1', null, 50, 2],
  [5, '5', 'Cashless', -5, null],
  [0, '0', 'Gotovina', 'n/a', 0],
  [null, null, 'Gotovina ', null, 3],
];
/** Each formula, what Excel 16 made of it, and what this makes of it where the two differ on purpose. */
export const EXCEL_ANSWERS = [
  ['SUMIFS(Podaci!D2:D9,Podaci!A2:A9,5)', 25],
  ['SUMIFS(Podaci!D2:D9,Podaci!B2:B9,5)', 25],
  ['SUMIFS(Podaci!D2:D9,Podaci!B2:B9,"5")', 25],
  ['SUMIFS(Podaci!D2:D9,Podaci!A2:A9,"5")', 25],
  ['SUMIFS(Podaci!D2:D9,Podaci!C2:C9,"K – kartice")', 30],
  ['SUMIFS(Podaci!D2:D9,Podaci!C2:C9,"K - kartice")', 40],
  ['SUMIFS(Podaci!D2:D9,Podaci!C2:C9,"gotovina")', 30],
  ['SUMIFS(Podaci!D2:D9,Podaci!C2:C9,"<>Gotovina")', 115],
  ['SUMIFS(Podaci!D2:D9,Podaci!E2:E9,"<>0")', 95],
  ['SUMIFS(Podaci!D2:D9,Podaci!D2:D9,">0")', 150],
  ['SUMIFS(Podaci!D2:D9,Podaci!D2:D9,"<0")', -5],
  ['SUMIFS(Podaci!D2:D9,Podaci!A2:A9,5,Podaci!C2:C9,"Gotovina")', 30],
  ['SUMIFS(Podaci!D2:D9,Podaci!A2:A8,5)', '#VALUE!', null],
  ['COUNTIFS(Podaci!A2:A9,5,Podaci!C2:C8,"Gotovina")', '#VALUE!', null],
  ['COUNTIFS(Podaci!C2:C9,"<>Gotovina")', 5],
  ['COUNTIFS(Podaci!E2:E9,"<>0")', 5],
  ['COUNTIFS(Podaci!E2:E9,0)', 3],
  ['COUNTIFS(Podaci!E2:E9,"0")', 3],
  ['COUNTIFS(Podaci!C2:C9,"")', 1],
  ['COUNTIFS(Podaci!C2:C9,"<>")', 7],
  ['COUNTIFS(Podaci!D2:D9,">0")', 5],
  ['COUNTIFS(Podaci!D2:D9,"<>5")', 8],
  ['COUNTIFS(Podaci!A2:A9,">=5")', 5],
  ['COUNTIFS(Podaci!A2:A9,"<=5")', 5],
  ['COUNTIFS(Podaci!A2:A9,"=5")', 3],
  ['COUNTIFS(Podaci!B2:B9,">4")', 0],
  ['COUNTIFS(Podaci!C2:C9,">H")', 2, null],
  ['COUNTIFS(Podaci!A2:A9,5,Podaci!C2:C9,"Gotovina")', 2],
  ['COUNTIFS(Podaci!C2:C9,"Goto*")', 4, null],
  ['COUNTIFS(Podaci!C2:C9,"=Gotovina")', 3],
  ['COUNTIFS(Podaci!C2:C9,"= Gotovina")', 0],
  ['COUNTIFS(Podaci!A2:A9,"5.0")', 0, null],
  ['COUNTIFS(Podaci!A2:A9,"5,0")', 3, null],
];
