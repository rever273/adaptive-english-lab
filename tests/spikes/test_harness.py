"""CPU-only checks of measurement/guards, never mocked GPU success."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('spikes',Path(__file__).with_name('run_environment_spikes.py'))
h=importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class HarnessTests(unittest.TestCase):
    def test_nearest_rank_and_empty(self):
        self.assertIsNone(h.percentile([], .95))
        self.assertEqual(h.percentile(list(range(1,21)),.95),19)

    def test_stale_and_pressure_are_distinct(self):
        self.assertEqual(h.admission(16311,2000,10000,6),'telemetry_unavailable')
        self.assertEqual(h.admission(16311,10000,5000,0),'waiting_for_gpu')
        self.assertEqual(h.admission(16311,2000,10000,0),'ready')

    def test_decision_is_not_chat(self):
        route,payload=h.model_payload('nimble-v3:latest',0)
        self.assertEqual(route,'/v1/systemone')
        self.assertNotIn('options',payload)
        self.assertEqual(payload['questions']['review']['type'],'choice')

    def test_strict_triage_response(self):
        response={'message':{'content':'{"schema_version":"triage-v1","needs_deep_review":false,"reason":"no_issue","skill_candidates":[]}'}}
        h.validate_model('qwen3:8b',response)
        response['message']['content']='{"mastery":10}'
        with self.assertRaises(Exception): h.validate_model('qwen3:8b',response)

    def test_nimble_probability_contract(self):
        response={'answers':{'review':{'type':'choice','choice':'review','probabilities':{'review':.8,'no_issue':.2},'confidence':.3}}}
        h.validate_model('nimble-v3:latest',response)
        response['answers']['review']['probabilities']['review']=1.5
        with self.assertRaises(AssertionError): h.validate_model('nimble-v3:latest',response)


if __name__=='__main__': unittest.main()
