import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('selection_ops',Path(__file__).resolve().parents[1]/'ops/selection-public/manage.py')
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)

class PublicSelectionOperations(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  ops.BASE=self.root/'base';ops.BASE.mkdir();ops.DATA=self.root/'data';ops.DATA.mkdir()
  ops.STATE=ops.BASE/'activation.json';ops.VHOST=self.root/'nginx.conf'
  (ops.BASE/'prepared.json').write_text('{"ready":true}')
  self.original='server { location = /api/public/selection/explorer { limit_except GET { deny all; } proxy_pass http://127.0.0.1:3286; } location ^~ /r/ { proxy_pass http://127.0.0.1:3282; } root /var/www/original; }'
  ops.VHOST.write_text(self.original)
  self.run=patch.object(ops,'run',return_value=None);self.commands=self.run.start()
  self.get=patch.object(ops,'get',side_effect=lambda u:{'enabled':['fossils','agent-economics']} if u.endswith('/features') else {'state':'ready'});self.get.start()
 def tearDown(self):self.get.stop();self.run.stop();self.tmp.cleanup()
 def test_switches_only_exact_explorer_proxy_and_can_restore_it(self):
  ops.activate();changed=ops.VHOST.read_text();self.assertIn('http://127.0.0.1:3287;',changed)
  self.assertIn('location ^~ /r/ { proxy_pass http://127.0.0.1:3282; }',changed)
  ops.rollback();self.assertEqual(ops.VHOST.read_text(),self.original)
 def test_nginx_failure_restores_original(self):
  calls=0
  def run(*args):
   nonlocal calls
   if args==('nginx','-t'):
    calls+=1
    if calls==1:raise RuntimeError('fixture syntax failure')
  self.commands.side_effect=run
  with self.assertRaises(RuntimeError):ops.activate()
  self.assertEqual(ops.VHOST.read_text(),self.original);self.assertFalse(ops.STATE.exists())
 def test_later_website_configuration_is_never_overwritten(self):
  ops.activate();later=ops.VHOST.read_text()+' # later release';ops.VHOST.write_text(later)
  with self.assertRaises(AssertionError):ops.rollback()
  self.assertEqual(ops.VHOST.read_text(),later)
 def test_requires_authorized_enabled_feature(self):
  with patch.object(ops,'get',return_value={'enabled':['fossils']}):
   with self.assertRaises(AssertionError):ops.activate()
  self.assertEqual(ops.VHOST.read_text(),self.original)
 def test_copies_only_unchanged_index_and_leaves_source_untouched(self):
  source=self.root/'source';source.mkdir();(source/'record').write_bytes(b'canonical evidence')
  before=ops.inventory(source);ops.snapshot(source,ops.DATA/'index')
  self.assertEqual(ops.inventory(ops.DATA/'index'),before);self.assertEqual(ops.inventory(source),before)
 def test_rejects_busy_index_and_cleans_temporary_copies(self):
  source=self.root/'source';source.mkdir();(source/'record').write_bytes(b'original')
  count=0
  def changing(_):
   nonlocal count
   count+=1;return {'record':str(count)}
  with patch.object(ops,'inventory',side_effect=changing),patch.object(ops.time,'sleep'):
   with self.assertRaises(RuntimeError):ops.snapshot(source,ops.DATA/'index')
  self.assertEqual(list(ops.DATA.iterdir()),[]);self.assertEqual((source/'record').read_bytes(),b'original')
 def test_existing_activation_is_not_silently_replaced(self):
  ops.activate()
  with self.assertRaises(AssertionError):ops.activate()

if __name__=='__main__':unittest.main()
