"""Rebuild small real PDFs with ReportLab and pypdf (test tooling only; no runtime dependency)."""
from pathlib import Path
from io import BytesIO
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter
from PIL import Image

root=Path(__file__).parent
for name,compression in [('plain.pdf',0),('compressed.pdf',1)]:
 c=Canvas(str(root/name),pageCompression=compression,invariant=1)
 c.drawString(72,720,'Payment due in 30 days.');c.save()
c=Canvas(str(root/'winansi.pdf'),pageCompression=1,invariant=1)
c.drawString(72,720,'Café € 1.5 payment.');c.save()
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
c=Canvas(str(root/'chinese.pdf'),pageCompression=1,invariant=1)
c.setFont('STSong-Light',12);c.drawString(72,720,'验收合格后30日内完成付款。');c.save()
c=Canvas(str(root/'scanned.pdf'),pageCompression=1,invariant=1)
image=Image.new('RGB',(64,64),'white');c.drawImage(ImageReader(image),72,600,128,128);c.save()
writer=PdfWriter();writer.append_pages_from_reader(PdfReader(root/'plain.pdf'));writer.encrypt('fixture-password')
with (root/'encrypted.pdf').open('wb') as f:writer.write(f)
(root/'damaged.pdf').write_bytes((root/'compressed.pdf').read_bytes()[:40])
