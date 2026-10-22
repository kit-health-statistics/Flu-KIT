import { FORECASTLE_CONFIG } from './forecastle';
import { CHART_CONFIG } from './visualization';

export { FORECASTLE_CONFIG };
export { CHART_CONFIG };

export const getConfig = () => ({
  forecastle: FORECASTLE_CONFIG,
  chart: CHART_CONFIG,
});