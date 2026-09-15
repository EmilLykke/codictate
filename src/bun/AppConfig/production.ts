import { AppConfig, type AppConfigDependencies } from './AppConfig'
import {
  DEFAULT_HISTORY_DIR,
  DICTIONARY_CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  MAIN_CONFIG_PATH,
  getPlatformCapabilities,
} from '../platform/runtime'
import { modelManager } from '../utils/whisper/model-manager'
import {
  detectFormattingAvailable,
  isFormatterModelInstalled,
} from '../utils/formatting/formatting-availability'

const productionDependencies: AppConfigDependencies = {
  paths: {
    mainConfig: MAIN_CONFIG_PATH,
    dictionaryConfig: DICTIONARY_CONFIG_PATH,
    legacyConfig: LEGACY_CONFIG_PATH,
    defaultHistory: DEFAULT_HISTORY_DIR,
  },
  getPlatformCapabilities,
  isModelAvailable: (id) => modelManager.isModelAvailable(id),
  getModelAvailability: () => modelManager.getAvailabilityMap(),
  detectFormattingAvailable,
  isFormatterModelInstalled,
}

/** Production adapter for filesystem, platform, and installed-model dependencies. */
export function createProductionAppConfig(): AppConfig {
  return new AppConfig(productionDependencies)
}
