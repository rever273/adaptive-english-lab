import { journeyProgress } from '../journey/model';
import { useJourney } from '../journey/useJourney';

export function JourneyButton({ onOpen }: { onOpen: () => void }) {
    const { data } = useJourney();
    const p = data ? journeyProgress(data) : null;
    return (
        <button
            type="button"
            className="journey-header"
            onClick={onOpen}
            aria-label={p ? `Journey, ${(p.stageProgress * 100).toFixed(2)} percent of current hours goal` : 'Open journey'}
            title={p ? `${(p.stageProgress * 100).toFixed(2)}% of current hours goal` : 'Open journey'}
        >
            <span>✦ Journey</span>
            <span className="journey-header-track">
                <span style={{ width: `${p ? p.stageProgress * 100 : 0}%` }} />
            </span>
        </button>
    );
}
