import type { JourneyData, JourneyMode } from '../api';
import { MODES } from '../journey/model';

/** Least-complete enabled practice first; ties keep the configured base order. */
export function dailyOrder(
    dailyMinutes: JourneyData['dailyMinutes'],
    todayMs: JourneyData['todayMs'],
    base: JourneyMode[] = MODES,
): JourneyMode[] {
    const percent = (mode: JourneyMode) => Math.min(100, Math.round((todayMs[mode] / (dailyMinutes[mode] * 60000)) * 100));
    return base.filter((mode) => dailyMinutes[mode] > 0).sort((a, b) => {
        const doneA = todayMs[a] >= dailyMinutes[a] * 60000;
        const doneB = todayMs[b] >= dailyMinutes[b] * 60000;
        return Number(doneA) - Number(doneB) || percent(a) - percent(b);
    });
}
