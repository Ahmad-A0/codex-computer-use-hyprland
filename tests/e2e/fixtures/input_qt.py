"""Disposable Qt 6 app for input-fidelity tests: a line edit, a plain-text
document and an extended-selection list. Run with
QT_WAYLAND_DISABLE_WINDOWDECORATION=1, so widget coordinates are window
coordinates. State (with item geometry) goes to STATE_JSON, atomically.
Usage: input_qt.py STATE_JSON APP_ID"""
import json
import sys
from pathlib import Path
from PyQt6.QtCore import QEvent, QObject, QPoint, QTimer
from PyQt6.QtWidgets import (QAbstractItemView, QApplication, QLineEdit, QListWidget, QPlainTextEdit,
                             QVBoxLayout, QWidget)

out, app_id = Path(sys.argv[1]), sys.argv[2]
app = QApplication([sys.argv[0]])
app.setDesktopFileName(app_id)
window = QWidget()
window.setWindowTitle('Codex E2E Qt Input')
layout = QVBoxLayout(window)
line = QLineEdit()
line.setAccessibleName('Qt input line')
document = QPlainTextEdit()
document.setAccessibleName('Qt input text')
document.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
document.setPlainText('\n'.join(f'Line {i:03d}: scrolling document text' for i in range(400)))
items = QListWidget()
items.setAccessibleName('Qt input list')
items.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
items.addItems([f'Qt row {i}' for i in range(8)])
items.setFixedHeight(8 * items.sizeHintForRow(0) + 8)
layout.addWidget(line)
layout.addWidget(items)
layout.addWidget(document)
wheels = []  # every wheel event Qt delivers: receiver, phase, angle and pixel deltas


class WheelLog(QObject):
    def eventFilter(self, receiver, event):
        if event.type() == QEvent.Type.Wheel:
            wheels.append([receiver.metaObject().className(), event.phase().name,
                           event.angleDelta().y(), event.pixelDelta().y(), event.angleDelta().x()])
            del wheels[:-60]
            dirty()
        return False


wheel_log = WheelLog()
app.installEventFilter(wheel_log)
timer = QTimer()
timer.setSingleShot(True)
timer.setInterval(20)


def rect(widget, r=None):
    r = r if r is not None else widget.rect()
    p = widget.mapTo(window, QPoint(r.x(), r.y()))
    return [p.x(), p.y(), r.width(), r.height()]


def flush():
    cursor = document.textCursor()
    bar = document.verticalScrollBar()
    start = line.selectionStart()
    state = {
        'text': line.text(), 'selection': [start, start + len(line.selectedText())] if start >= 0 else [],
        'document': document.toPlainText(),
        'docSelection': [cursor.selectionStart(), cursor.selectionEnd()] if cursor.hasSelection() else [],
        'v': {'value': bar.value(), 'max': bar.maximum(), 'page': bar.pageStep(), 'step': bar.singleStep()},
        'h': {'value': document.horizontalScrollBar().value()},
        'listSelection': sorted(items.row(i) for i in items.selectedItems()), 'wheel': wheels,
        'geometry': {'line': rect(line), 'document': rect(document), 'list': rect(items),
                     'rows': [rect(items.viewport(), items.visualItemRect(items.item(i))) for i in range(items.count())]},
    }
    temporary = out.with_name(out.name + '.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(out)


timer.timeout.connect(flush)
dirty = lambda *_: timer.start()
line.textChanged.connect(dirty)
line.selectionChanged.connect(dirty)
line.cursorPositionChanged.connect(dirty)
document.textChanged.connect(dirty)
document.cursorPositionChanged.connect(dirty)
document.selectionChanged.connect(dirty)
document.verticalScrollBar().valueChanged.connect(dirty)
document.horizontalScrollBar().valueChanged.connect(dirty)
items.itemSelectionChanged.connect(dirty)
window.resize(700, 760)
window.show()
dirty()
# Geometry once the floating window has its final size.
for delay in (300, 1500):
    QTimer.singleShot(delay, flush)
app.exec()
