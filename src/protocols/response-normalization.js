// Smart Router Mainline - Provider response compatibility helpers.
//
// Some OpenAI-compatible providers occasionally serialize a single chat choice
// as an object instead of the required choices array. Normalize only the
// unambiguous shapes we can safely recover; leave unknown shapes untouched so
// validation can classify them as incomplete rather than inventing content.

/**
 * Normalize a provider Chat Completions response to the OpenAI array shape.
 *
 * @param {object|null} response Provider response body.
 * @returns {object|null} A response with a normalized choices array when safe.
 */
export function normalizeChatCompletionResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'choices')
    || Array.isArray(response.choices)) {
    return response;
  }

  const choices = response.choices;
  if (!choices || typeof choices !== 'object') return response;

  const keys = Object.keys(choices);
  const numericKeys = keys.length > 0 && keys.every((key) => /^\d+$/.test(key));
  if (numericKeys) {
    const normalizedChoices = keys
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => choices[key]);
    return { ...response, choices: normalizedChoices };
  }

  const hasChoiceFields = [
    'index',
    'message',
    'delta',
    'finish_reason',
  ].some((key) => Object.prototype.hasOwnProperty.call(choices, key));
  if (hasChoiceFields) {
    return { ...response, choices: [choices] };
  }

  return response;
}

export default { normalizeChatCompletionResponse };
