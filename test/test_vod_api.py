import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from fastapi.testclient import TestClient
from server import app


class APITests(unittest.TestCase):
    def setUp(self): self.client=TestClient(app,base_url='http://127.0.0.1:8765')

    def test_key_is_not_returned_and_foreign_websites_cannot_modify_settings(self):
        response=self.client.get('/api/settings')
        self.assertEqual(response.status_code,200)
        self.assertNotIn('api_key',response.json())
        hostile=self.client.put('/api/settings',json={'api_key':'not-real'},headers={'Origin':'https://attacker.example','Sec-Fetch-Site':'cross-site'})
        self.assertEqual(hostile.status_code,403)
        rebound=self.client.get('/api/settings',headers={'Host':'attacker.example'})
        self.assertEqual(rebound.status_code,403)

    def test_launch_only_registers_source_without_starting_paid_processing(self):
        response=self.client.post('/api/launch',json={'source':'https://example.com/movie.m3u8'})
        self.assertEqual(response.status_code,200)
        token=response.json()['url'].split('launch=')[1]
        self.assertIn('?launch=',response.json()['url'])
        launched=self.client.get('/api/launch/'+token)
        self.assertEqual(launched.json()['source'],'https://example.com/movie.m3u8')

    def test_unfinished_or_unknown_segment_cannot_be_downloaded(self):
        self.assertEqual(self.client.get('/api/sessions/missing/segments/0.ts').status_code,404)
        self.assertEqual(self.client.get('/api/sessions/missing/playlist.m3u8').status_code,404)

    def test_missing_key_fails_before_remote_media_is_downloaded(self):
        from unittest.mock import patch
        with patch('vod.public_settings',return_value={'key_configured':False}):
            result=self.client.post('/api/sessions',json={'source':'https://example.com/movie.m3u8'})
        self.assertEqual(result.status_code,400)
        self.assertIn('API key',result.json()['detail'])

    def test_player_and_bundled_hls_load_without_external_cdns(self):
        response=self.client.get('/player/')
        self.assertEqual(response.status_code,200)
        self.assertIn('vendor/hls.min.js',response.text)
        self.assertEqual(self.client.get('/player/vendor/hls.min.js').status_code,200)


if __name__=='__main__':unittest.main(verbosity=2)
