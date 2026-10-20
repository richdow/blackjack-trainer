// Basic strategy charts transcribed cell-by-cell from Wizard of Odds chart images
// (https://wizardofodds.com/blackjack/images/bj_4d_h17.gif, bj_4d_s17.gif,
//  bj_2d_h17.gif, bj_1d_h17.gif; pages /games/blackjack/strategy/{4-decks,2-decks,1-deck}/).
// Columns: dealer 2,3,4,5,6,7,8,9,10,A. Codes as printed: Dh, Ds, Ph, Pd, Ps, Rh, Rs, Rp.
export const WIZ = {
  '4-8 decks H17': {
    hard: {
      8: 'H H H H H H H H H H', 9: 'H Dh Dh Dh Dh H H H H H', 10: 'Dh Dh Dh Dh Dh Dh Dh Dh H H',
      11: 'Dh Dh Dh Dh Dh Dh Dh Dh Dh Dh', 12: 'H H S S S H H H H H', 13: 'S S S S S H H H H H',
      14: 'S S S S S H H H H H', 15: 'S S S S S H H H Rh Rh', 16: 'S S S S S H H Rh Rh Rh',
      17: 'S S S S S S S S S Rs', 18: 'S S S S S S S S S S',
    },
    soft: {
      13: 'H H H Dh Dh H H H H H', 14: 'H H H Dh Dh H H H H H', 15: 'H H Dh Dh Dh H H H H H',
      16: 'H H Dh Dh Dh H H H H H', 17: 'H Dh Dh Dh Dh H H H H H', 18: 'Ds Ds Ds Ds Ds S S H H H',
      19: 'S S S S Ds S S S S S', 20: 'S S S S S S S S S S',
    },
    pair: {
      2: 'Ph Ph P P P P H H H H', 3: 'Ph Ph P P P P H H H H', 4: 'H H H Ph Ph H H H H H',
      6: 'Ph P P P P H H H H H', 7: 'P P P P P P H H H H', 8: 'P P P P P P P P P Rp',
      9: 'P P P P P S P P S S', 1: 'P P P P P P P P P P',
    },
  },
  '4-8 decks S17': {
    hard: {
      8: 'H H H H H H H H H H', 9: 'H Dh Dh Dh Dh H H H H H', 10: 'Dh Dh Dh Dh Dh Dh Dh Dh H H',
      11: 'Dh Dh Dh Dh Dh Dh Dh Dh Dh H', 12: 'H H S S S H H H H H', 13: 'S S S S S H H H H H',
      14: 'S S S S S H H H H H', 15: 'S S S S S H H H Rh H', 16: 'S S S S S H H Rh Rh Rh',
      17: 'S S S S S S S S S S',
    },
    soft: {
      13: 'H H H Dh Dh H H H H H', 14: 'H H H Dh Dh H H H H H', 15: 'H H Dh Dh Dh H H H H H',
      16: 'H H Dh Dh Dh H H H H H', 17: 'H Dh Dh Dh Dh H H H H H', 18: 'S Ds Ds Ds Ds S S H H H',
      19: 'S S S S S S S S S S',
    },
    pair: {
      2: 'Ph Ph P P P P H H H H', 3: 'Ph Ph P P P P H H H H', 4: 'H H H Ph Ph H H H H H',
      6: 'Ph P P P P H H H H H', 7: 'P P P P P P H H H H', 8: 'P P P P P P P P P P',
      9: 'P P P P P S P P S S', 1: 'P P P P P P P P P P',
    },
  },
  '2 decks H17': {
    hard: {
      8: 'H H H H H H H H H H', 9: 'Dh Dh Dh Dh Dh H H H H H', 10: 'Dh Dh Dh Dh Dh Dh Dh Dh H H',
      11: 'Dh Dh Dh Dh Dh Dh Dh Dh Dh Dh', 12: 'H H S S S H H H H H', 13: 'S S S S S H H H H H',
      14: 'S S S S S H H H H H', 15: 'S S S S S H H H Rh Rh', 16: 'S S S S S H H H Rh Rh',
      17: 'S S S S S S S S S Rs',
    },
    soft: {
      13: 'H H H Dh Dh H H H H H', 14: 'H H Dh Dh Dh H H H H H', 15: 'H H Dh Dh Dh H H H H H',
      16: 'H H Dh Dh Dh H H H H H', 17: 'H Dh Dh Dh Dh H H H H H', 18: 'Ds Ds Ds Ds Ds S S H H H',
      19: 'S S S S Ds S S S S S', 20: 'S S S S S S S S S S',
    },
    pair: {
      2: 'Ph Ph P P P P H H H H', 3: 'Ph Ph P P P P H H H H', 4: 'H H H Ph Ph H H H H H',
      6: 'P P P P P Ph H H H H', 7: 'P P P P P P Ph H H H', 8: 'P P P P P P P P P Rp2',
      9: 'P P P P P S P P S S', 1: 'P P P P P P P P P P',
    },
  },
  '1 deck H17': {
    hard: {
      7: 'H H H H H H H H H H', 8: 'H H H Dh Dh H H H H H', 9: 'Dh Dh Dh Dh Dh H H H H H', 10: 'Dh Dh Dh Dh Dh Dh Dh Dh H H',
      11: 'Dh Dh Dh Dh Dh Dh Dh Dh Dh Dh', 12: 'H H S S S H H H H H', 13: 'S S S S S H H H H H',
      14: 'S S S S S H H H H H', 15: 'S S S S S H H H H Rh', 16: 'S S S S S H H H Rh Rh',
      17: 'S S S S S S S S S Rs',
    },
    soft: {
      13: 'H H Dh Dh Dh H H H H H', 14: 'H H Dh Dh Dh H H H H H', 15: 'H H Dh Dh Dh H H H H H',
      16: 'H H Dh Dh Dh H H H H H', 17: 'Dh Dh Dh Dh Dh H H H H H', 18: 'S Ds Ds Ds Ds S S H H H',
      19: 'S S S S Ds S S S S S', 20: 'S S S S S S S S S S',
    },
    pair: {
      2: 'Ph P P P P P H H H H', 3: 'Ph Ph P P P P Ph H H H', 4: 'H H Ph Pd Pd H H H H H',
      6: 'P P P P P Ph H H H H', 7: 'P P P P P P Ph H Rs Rh', 8: 'P P P P P P P P P P',
      9: 'P P P P P S P P S Ps', 1: 'P P P P P P P P P P',
    },
  },
};
/** Translate a printed Wizard code into the code our generator should emit for the given rules. */
export function expectCode(w, { das, surrender }) {
  const sur = surrender === 'late';
  switch (w) {
    case 'Dh': return 'D';
    case 'Ph': return das ? 'P' : 'H';
    case 'Pd': return das ? 'P' : 'D';
    case 'Ps': return das ? 'P' : 'S';
    case 'Rh': return sur ? 'Rh' : 'H';
    case 'Rs': return sur ? 'Rs' : 'S';
    case 'Rp': return sur ? 'Rp' : 'P';
    case 'Rp2': return sur && !das ? 'Rp' : 'P'; // double-deck footnote: surrender only if no DAS
    default: return w;
  }
}
