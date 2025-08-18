import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

let lastReceiveRequest: any = null;

export const handlers = [
  http.post('*/inventory/receivings', async ({ request }) => {
    try {
      const body = await request.json();
      lastReceiveRequest = body;
      return HttpResponse.json({ id: 'rcv_1', status: 'OK' }, { status: 200 });
    } catch (e) {
      return HttpResponse.json({ message: 'Bad Request' }, { status: 400 });
    }
  }),
];

export const server = setupServer(...handlers);

export function setReceiveError(message = 'Unprocessable', status = 422) {
  server.use(
    http.post('*/inventory/receivings', async () => {
      return HttpResponse.json({ message }, { status });
    })
  );
}

export function getLastReceiveRequest() {
  return lastReceiveRequest;
}
