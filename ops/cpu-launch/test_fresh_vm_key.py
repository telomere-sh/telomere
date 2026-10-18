"""Regression for a virtio port opened before the sender connects."""
import importlib.util,io,struct,unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('fresh_key_guest',Path(__file__).with_name('fresh-vm-guest.py'))
guest=importlib.util.module_from_spec(spec);spec.loader.exec_module(guest)

class Port:
    def __init__(self,chunks):self.chunks=list(chunks);self.acknowledgements=[]
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,size):
        value=self.chunks.pop(0) if self.chunks else b''
        if len(value)>size:self.chunks.insert(0,value[size:]);value=value[:size]
        return value
    def write(self,value):self.acknowledgements.append(value);return len(value)

class KeyTransportTests(unittest.TestCase):
    def receive(self,port,clock=None):
        with patch.object(guest,'progress'),patch.object(Path,'open',return_value=port),patch.object(guest.time,'sleep'),patch.object(guest.time,'monotonic',side_effect=clock) if clock else patch.object(guest.time,'monotonic',return_value=0):
            return guest.read_identity()
    def test_initial_eof_and_fragmented_frame_wait_for_sender(self):
        identity=b'# fixture\nAGE-SECRET-KEY-not-a-real-key\n';header=struct.pack('!I',len(identity))
        port=Port([b'',b'',header[:1],header[1:],identity[:7],identity[7:]])
        self.assertEqual(self.receive(port),identity);self.assertEqual(port.acknowledgements,[b'OK'])
    def test_oversized_frame_stops_before_reading_identity(self):
        port=Port([struct.pack('!I',16385),b'unread payload'])
        with self.assertRaises(AssertionError):self.receive(port)
        self.assertEqual(port.acknowledgements,[]);self.assertEqual(port.chunks,[b'unread payload'])
    def test_disconnected_sender_has_finite_deadline(self):
        port=Port([])
        with self.assertRaises(AssertionError):self.receive(port,[0,601])
        self.assertEqual(port.acknowledgements,[])
    def test_non_identity_payload_is_rejected(self):
        value=b'not an age identity';port=Port([struct.pack('!I',len(value)),value])
        with self.assertRaises(AssertionError):self.receive(port)

if __name__=='__main__':unittest.main()
