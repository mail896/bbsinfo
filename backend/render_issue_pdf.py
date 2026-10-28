"""Render a published BBS Info issue to a standalone PDF on stdout."""
import html
import io
import json
import os
import re
import sys

from bs4 import BeautifulSoup, NavigableString, Tag
from PIL import Image as PillowImage, ImageOps
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from pypdf import PdfReader, PdfWriter


FONT_DIR = '/usr/share/fonts/truetype/dejavu'
pdfmetrics.registerFont(TTFont('BBS', os.path.join(FONT_DIR, 'DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('BBS-Bold', os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')))
pdfmetrics.registerFontFamily('BBS', normal='BBS', bold='BBS-Bold')
INK = colors.HexColor('#172332')
BLUE = colors.HexColor('#164e70')
YELLOW = colors.HexColor('#ffe149')
STYLES = {
    'title': ParagraphStyle('title', fontName='BBS-Bold', fontSize=23, leading=29, textColor=INK, spaceAfter=14),
    'h2': ParagraphStyle('h2', fontName='BBS-Bold', fontSize=14, leading=19, textColor=INK, spaceBefore=15, spaceAfter=7),
    'h3': ParagraphStyle('h3', fontName='BBS-Bold', fontSize=11, leading=16, textColor=INK, spaceBefore=12, spaceAfter=5),
    'body': ParagraphStyle('body', fontName='BBS', fontSize=9.5, leading=15, textColor=INK, spaceAfter=8),
    'meta': ParagraphStyle('meta', fontName='BBS', fontSize=8, leading=12, textColor=BLUE, spaceAfter=16),
}


def inline(node):
    if isinstance(node, NavigableString):
        return html.escape(str(node))
    if not isinstance(node, Tag):
        return ''
    inner = ''.join(inline(child) for child in node.children)
    if node.name == 'br':
        return '<br/>'
    tags = {'strong': 'b', 'b': 'b', 'em': 'i', 'i': 'i', 'u': 'u', 's': 'strike', 'sub': 'sub', 'sup': 'super'}
    if node.name in tags:
        return f'<{tags[node.name]}>{inner}</{tags[node.name]}>'
    if node.name == 'a' and str(node.get('href', '')).startswith(('https://', 'http://')):
        return f'<link href="{html.escape(node["href"], quote=True)}">{inner}</link>'
    return inner


def safe_image(tag, image_root, max_width):
    source = str(tag.get('src', ''))
    match = re.fullmatch(r'/bbsinfo/editor-images/([0-9a-f-]{36})', source, re.I)
    if not image_root or not match:
        return None
    name = match.group(1).lower()
    if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', name):
        return None
    path = os.path.join(image_root, name)
    try:
        if os.stat(path).st_size > 3 * 1024 * 1024:
            return None
        picture_data, width, height = compact_image(path)
        requested = re.search(r'width:\s*(\d{1,4})px', str(tag.get('style', '')))
        display_width = min(max_width, width, int(requested.group(1)) * 0.75 if requested else 315, (A4[1] - 150) * width / height)
        return Image(picture_data, width=display_width, height=display_width * height / width, kind='proportional')
    except (OSError, ValueError):
        return None


def compact_image(path):
    """Keep enough pixels for print while avoiding ReportLab's large raw RGB streams."""
    with PillowImage.open(path) as source:
        width, height = source.size
        if width < 1 or height < 1 or width * height > 50_000_000:
            raise ValueError('Ungültige Bildgröße')
        picture = ImageOps.exif_transpose(source)
        width, height = picture.size
        if picture.mode in ('RGBA', 'LA') or 'transparency' in picture.info:
            rgba = picture.convert('RGBA')
            canvas = PillowImage.new('RGB', rgba.size, 'white')
            canvas.paste(rgba, mask=rgba.getchannel('A'))
            picture = canvas
        else:
            picture = picture.convert('RGB')
        picture.thumbnail((1800, 2200), PillowImage.Resampling.LANCZOS)
        output = io.BytesIO()
        picture.save(output, format='JPEG', quality=90, optimize=True)
        output.seek(0)
        return output, width, height


def blocks(markup, fallback, image_root, max_width):
    if not markup:
        return [Paragraph(html.escape(line), STYLES['body']) for line in str(fallback or '').splitlines() if line.strip()]
    result = []
    soup = BeautifulSoup(markup, 'html.parser')

    def visit(node):
        if isinstance(node, NavigableString):
            if str(node).strip():
                result.append(Paragraph(html.escape(str(node)), STYLES['body']))
            return
        if not isinstance(node, Tag):
            return
        if node.name == 'img':
            picture = safe_image(node, image_root, max_width)
            if picture:
                result.extend([Spacer(1, 5), picture, Spacer(1, 9)])
            return
        if node.name in ('h2', 'h3', 'h4', 'p', 'blockquote', 'li'):
            text = ''.join(inline(child) for child in node.children if not (isinstance(child, Tag) and child.name == 'img')).strip()
            if text:
                if node.name == 'li':
                    text = '&#8226; ' + text
                result.append(Paragraph(text, STYLES['h2' if node.name == 'h2' else 'h3' if node.name in ('h3', 'h4') else 'body']))
            for image in node.find_all('img'):
                picture = safe_image(image, image_root, max_width)
                if picture:
                    result.extend([picture, Spacer(1, 8)])
            return
        if node.name == 'table':
            rows = []
            for tr in node.find_all('tr')[:100]:
                cells = [Paragraph(''.join(inline(child) for child in cell.children), STYLES['body']) for cell in tr.find_all(['th', 'td'], recursive=False)[:8]]
                if cells:
                    rows.append(cells)
            if rows:
                columns = max(map(len, rows))
                for row in rows:
                    row.extend([''] * (columns - len(row)))
                table = Table(rows, colWidths=[max_width / columns] * columns, hAlign='LEFT', repeatRows=1)
                table.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), .35, colors.HexColor('#cbd4db')), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eef5fa')), ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6)]))
                result.extend([table, Spacer(1, 9)])
            return
        for child in node.children:
            visit(child)

    for child in soup.contents:
        visit(child)
    return result


def main():
    data = json.load(sys.stdin)
    issue = data['issue']
    root = data.get('editorImageRoot')
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=48, rightMargin=48, topMargin=62, bottomMargin=50, title=f'BBS Info {issue["number"]}', author='BBS Einbeck')
    width = A4[0] - 96
    story = [Paragraph('BBS EINBECK  /  INFORMATIONEN FÜR DAS KOLLEGIUM', STYLES['meta']), Paragraph(f'BBS Info {int(issue["number"])}', STYLES['title']), Paragraph(html.escape(issue['title']), STYLES['h2']), Paragraph(html.escape(' · '.join(filter(None, [issue.get('publishedAt'), issue.get('schoolYear'), issue.get('period')]))), STYLES['meta'])]
    story.extend(blocks(issue.get('bodyHtml'), issue.get('body'), root, width))
    for update in issue.get('updates', []):
        story.append(Paragraph(html.escape(update['title']), STYLES['h2']))
        story.extend(blocks(update.get('bodyHtml'), update.get('body'), root, width))
    for contribution in issue.get('contributions', []):
        story.append(Paragraph(html.escape(contribution['title']), STYLES['h2']))
        story.extend(blocks(contribution.get('bodyHtml'), contribution.get('body'), root, width))
        story.append(Paragraph('von ' + html.escape(contribution['author']), STYLES['meta']))
    if issue.get('attachments'):
        story.append(Paragraph('Steckbriefe', STYLES['h2']))

    def footer(canvas, pdf_doc):
        canvas.setStrokeColor(YELLOW)
        canvas.setLineWidth(2)
        canvas.line(48, 39, A4[0] - 48, 39)
        canvas.setFont('BBS', 8)
        canvas.setFillColor(BLUE)
        canvas.drawString(48, 26, f'BBS Info {int(issue["number"])}  ·  BBS Einbeck')
        canvas.drawRightString(A4[0] - 48, 26, str(pdf_doc.page))

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(buffer.getvalue())).pages:
        writer.add_page(page)
    for attachment in issue.get('attachments', []):
        path = attachment['path']
        media_type = attachment['mediaType']
        if media_type == 'application/pdf':
            pages = PdfReader(path, strict=False).pages
            if not 1 <= len(pages) <= 100:
                raise ValueError('Ungültige Steckbriefseitenzahl')
            for page in pages:
                writer.add_page(page)
        elif media_type in ('image/jpeg', 'image/png', 'image/webp'):
            picture_data, image_width, image_height = compact_image(path)
            page_buffer = io.BytesIO()
            page_doc = SimpleDocTemplate(page_buffer, pagesize=A4, leftMargin=48, rightMargin=48, topMargin=62, bottomMargin=50)
            max_height = A4[1] - 195
            scale = min(width / image_width, max_height / image_height)
            image = Image(picture_data, width=image_width * scale, height=image_height * scale)
            page_doc.build([Paragraph(html.escape(attachment['title']), STYLES['h2']), Spacer(1, 12), image])
            for page in PdfReader(io.BytesIO(page_buffer.getvalue())).pages:
                writer.add_page(page)
        else:
            raise ValueError('Unbekannter Steckbrieftyp')
    output = io.BytesIO()
    writer.write(output)
    sys.stdout.buffer.write(output.getvalue())


if __name__ == '__main__':
    main()
