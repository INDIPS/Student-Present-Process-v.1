import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import type { StudentRecord } from '../shared/types';

export function exportRowsToCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const val = String(row[h] ?? '');
          return `"${val.replace(/"/g, '""')}"`;
        })
        .join(',')
    ),
  ];
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportRowsToExcel(filename: string, sheetName: string, rows: Array<Record<string, unknown>>): void {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

export function exportRowsToPdf(
  filename: string,
  title: string,
  subtitle: string,
  rows: Array<Record<string, unknown>>
): void {
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFillColor(10, 17, 32);
  doc.rect(0, 0, 297, 26, 'F');
  doc.setTextColor(240, 249, 255);
  doc.setFontSize(15);
  doc.text(title, 14, 12);
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text(subtitle, 14, 20);

  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    const body = rows.map((r) => headers.map((h) => String(r[h] ?? '')));
    autoTable(doc, {
      startY: 32,
      head: [headers.map((h) => h.toUpperCase())],
      body,
      styles: { fontSize: 8, cellPadding: 2.5 },
      headStyles: { fillColor: [14, 116, 144], textColor: 255 },
    });
  } else {
    doc.setTextColor(100, 116, 139);
    doc.text('No records matched the selected filter criteria.', 14, 40);
  }

  doc.save(filename);
}

export function exportStudentIdCardPdf(student: StudentRecord, qrDataUrl: string): void {
  const doc = new jsPDF({ unit: 'mm', format: [92, 58], orientation: 'landscape' });
  doc.setFillColor(8, 15, 34);
  doc.rect(0, 0, 92, 58, 'F');

  doc.setDrawColor(56, 189, 248);
  doc.setLineWidth(0.5);
  doc.rect(2, 2, 88, 54);

  doc.setTextColor(56, 189, 248);
  doc.setFontSize(8.5);
  doc.text('AEGISCAMPUS SMART IDENTITY CARD', 5, 8);

  doc.setTextColor(241, 245, 249);
  doc.setFontSize(11);
  doc.text(student.fullName, 5, 17);

  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text(`ID: ${student.admissionNumber}`, 5, 23);
  doc.text(`Class: ${student.className} - ${student.sectionName} (Roll ${student.rollNumber})`, 5, 28);
  doc.text(`Session: ${student.sessionName}`, 5, 33);
  doc.text(`Branch: ${student.branchName}`, 5, 38);
  doc.text(`Emergency: ${student.emergencyPhone}`, 5, 43);

  doc.setTextColor(34, 197, 94);
  doc.setFontSize(6.5);
  doc.text(`DPDP Consent Verified · QR: ${student.qrTokenId}`, 5, 51);

  if (qrDataUrl) {
    doc.setFillColor(255, 255, 255);
    doc.rect(63, 13, 24, 24, 'F');
    doc.addImage(qrDataUrl, 'PNG', 64, 14, 22, 22);
  }

  doc.save(`${student.admissionNumber}-id-card.pdf`);
}
