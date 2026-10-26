import { parentPort, workerData } from "node:worker_threads";
import { ChartError, type ChartSpec, drawChart } from "./charts.ts";
import { DocumentError, documentText, unsignedData } from "./documents.ts";
import { MakeError, type MakeInput, makeDocument } from "./make-document.ts";
import { P7mError } from "./p7m.ts";
import { pdfPageImage } from "./pdf-images.ts";
import { PdfError } from "./pdf-objects.ts";

/**
 * Runs one extraction for document-reader.ts, away from the event loop that serves everyone:
 * a document's text, with `page` the picture on that page of a PDF (ADR 0028), or with `make`
 * a Word, Excel or PDF file to write (ADR 0029), with `chart` a chart to draw (ADR 0030).
 */
const { name, data, page, make, chart } = workerData as { name: string; data: Uint8Array; page?: number; make?: MakeInput; chart?: ChartSpec };
try {
	if (chart !== undefined) parentPort?.postMessage({ made: drawChart(chart) });
	else if (make !== undefined) parentPort?.postMessage({ made: makeDocument(make) });
	else if (page !== undefined) {
		// A signed PDF (.pdf.p7m): the pages of what was signed.
		const image = pdfPageImage(Buffer.from(unsignedData(data)), page);
		parentPort?.postMessage({ image });
	} else parentPort?.postMessage({ document: documentText(name, data) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof DocumentError || error instanceof PdfError || error instanceof P7mError || error instanceof MakeError || error instanceof ChartError ? error.message : chart !== undefined ? "non sono riuscita a disegnarlo" : make !== undefined ? "non sono riuscita a crearlo" : "il file è rovinato" });
}
