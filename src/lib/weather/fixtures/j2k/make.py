"""
JPEG 2000 test codestreams, written by OpenJPEG (through Pillow 12, OpenJPEG 2.5):
run `python make.py` here to rebuild them. Each .raw is the expected samples,
little-endian uint16: the source image, or OpenJPEG's own decoding where the
source cannot be used (lossy, and tiled, see below).
"""
import json, os, numpy as np
from PIL import Image
out = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(7)

def field(w, h, top=4095):
    y, x = np.mgrid[0:h, 0:w]
    f = 0.5 + 0.3 * np.sin(x / 7.0) * np.cos(y / 5.0) + 0.15 * np.sin((x + 2 * y) / 3.0)
    f = f + rng.normal(0, 0.02, size=f.shape)
    f[h // 3: h // 3 + 3, :] = 0.95  # a sharp front
    return np.clip(np.round(f * top), 0, top).astype(np.uint16)

cases = [
    ('lossless-default', 61, 43, 'I;16', {}),
    ('lossless-3res-cb16', 61, 43, 'I;16', {'num_resolutions': 3, 'codeblock_size': (16, 16)}),
    ('lossless-tiles', 70, 50, 'I;16', {'tile_size': (32, 32)}),
    ('lossless-offset', 45, 38, 'I;16', {'offset': (5, 3), 'tile_size': (24, 24), 'tile_offset': (0, 0)}),
    ('lossless-rlcp', 50, 40, 'I;16', {'progression': 'RLCP'}),
    ('lossless-rpcl-precincts', 80, 64, 'I;16', {'progression': 'RPCL', 'precinct_size': (32, 32), 'codeblock_size': (16, 16)}),
    ('lossless-pcrl-precincts', 80, 64, 'I;16', {'progression': 'PCRL', 'precinct_size': (32, 32), 'codeblock_size': (16, 16)}),
    ('lossless-cprl', 50, 40, 'I;16', {'progression': 'CPRL'}),
    ('lossless-8bit', 40, 30, 'L', {}),
    ('lossless-constant', 20, 12, 'I;16', {}),
    ('lossless-tiny', 3, 2, 'I;16', {'num_resolutions': 2}),
    ('lossy-97', 64, 48, 'I;16', {'irreversible': True, 'quality_mode': 'rates', 'quality_layers': [8]}),
    ('lossy-97-layers', 64, 48, 'I;16', {'irreversible': True, 'quality_mode': 'rates', 'quality_layers': [40, 12, 4]}),
    ('lossless-layers', 64, 48, 'I;16', {'quality_mode': 'rates', 'quality_layers': [20, 5, 1]}),
]
index = []
for name, w, h, mode, opts in cases:
    top = 255 if mode == 'L' else 4095
    a = field(w, h, top)
    if name == 'lossless-constant':
        a[:] = 1234
    img = Image.fromarray(a.astype(np.uint8) if mode == 'L' else a, mode=None)
    if mode == 'I;16':
        img = Image.frombytes('I;16', (w, h), a.astype('<u2').tobytes())
    path = os.path.join(out, name + '.j2k')
    img.save(path, **opts)
    back = np.array(Image.open(path)).astype(np.uint16)
    lossless = name.startswith('lossless')
    same = bool((back == a).all())
    # Pillow feeds OpenJPEG tiled images wrongly, so there the source is not what was
    # encoded: the expected samples are OpenJPEG's own decoding instead.
    use_source = lossless and same
    (a if use_source else back).astype('<u2').tofile(os.path.join(out, name + '.raw'))
    index.append({'name': name, 'width': w, 'height': h, 'lossless': lossless, 'bits': 8 if mode == 'L' else 16, 'bytes': os.path.getsize(path), 'pillowRoundTrip': same, 'expected': 'source' if use_source else 'openjpeg'})
json.dump(index, open(os.path.join(out, 'index.json'), 'w'), indent=1)
print('\n'.join(f"{c['name']}: {c['bytes']} B" for c in index))
