const REPLACEMENTS = [
  [/\bBattlestate Games\b/giu, 'Big Silly Goose'],
  [/\bBSG\b/giu, 'Big Silly Goose'],
  [/\bTarkov\b/giu, 'THE CITY'],
];

const REPLACEABLE_TEXT = /\b(?:Battlestate Games|BSG|Tarkov)\b/iu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createVisibleTextTransformer(protectedRecordNames = []) {
  const names = [...new Set(protectedRecordNames
    .map((name) => String(name || '').trim())
    .filter((name) => name && REPLACEABLE_TEXT.test(name)))]
    .sort((left, right) => right.length - left.length);
  const protectedPattern = names.length
    ? new RegExp(names.map(escapeRegExp).join('|'), 'giu')
    : null;

  return function transformVisibleText(value) {
    if (value === null || value === undefined || value === '') return value;
    const protectedValues = [];
    let output = String(value);
    const protect = (match) => {
      const index = protectedValues.push(match) - 1;
      return `\uE000${index}\uE001`;
    };
    output = output.replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/giu, protect);
    if (protectedPattern) {
      output = output.replace(protectedPattern, protect);
    }
    for (const [pattern, replacement] of REPLACEMENTS) {
      output = output.replace(pattern, replacement);
    }
    return output.replace(/\uE000(\d+)\uE001/gu, (_, index) => protectedValues[Number(index)]);
  };
}
