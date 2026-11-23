// Choosing a model in the settings: when the provider can be asked for its
// list, how a listed model is named, and what still stops a save.

import type { BackendOption, ModelOption } from '../host/types';

/** How a listed model is named in the dropdown. */
export function modelLabel(model: ModelOption): string {
  return model.name === model.id ? model.id : `${model.name} (${model.id})`;
}

/**
 * Whether to ask for the models as soon as the backend is shown: when the
 * provider can be asked with nothing more from the operator. That is a
 * stored key, or a server of the operator's own that needs none.
 */
export function listsOnOpen(option: BackendOption | undefined, baseUrl: string): boolean {
  if (!option || option.delegated) {
    return false;
  }
  return option.keyStored || (option.keyOptional && baseUrl.trim() !== '');
}

/** Whether the provider can be asked for its models now. */
export function canListModels(option: BackendOption | undefined, apiKey: string): boolean {
  if (!option || option.delegated) {
    return false;
  }
  return option.keyOptional || option.keyStored || apiKey.trim() !== '';
}

/**
 * Why an API key backend cannot be saved yet, said next to the button, or
 * null when it can. A delegated agent needs neither a key nor a model.
 */
export function saveBlocker(
  option: BackendOption | undefined,
  model: string,
  apiKey: string,
): string | null {
  if (!option || option.delegated) {
    return null;
  }
  if (!option.keyOptional && !option.keyStored && apiKey.trim() === '') {
    return 'Enter an API key to save.';
  }
  if (option.defaultModel === '' && model.trim() === '') {
    return 'Choose a model to save.';
  }
  return null;
}
