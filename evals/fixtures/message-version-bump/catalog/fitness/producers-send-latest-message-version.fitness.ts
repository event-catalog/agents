import { defineFitnessFunction } from '@eventcatalog/fitness';

// A producer should always document the version of each message it sends.
export default defineFitnessFunction({
  id: 'producers-send-latest-message-version',
  name: 'Producers send the latest version of their messages',
  severity: 'error',

  async run({ catalog }) {
    const services = (await catalog.getServices({ latestOnly: true })) ?? [];
    const events = (await catalog.getEvents({ latestOnly: true })) ?? [];
    const latest = new Map(events.map((event) => [event.id, event.version]));

    return services.flatMap((service) =>
      (service.sends ?? [])
        .filter((pin) => /^\d+\.\d+\.\d+$/.test(pin.version ?? '') && latest.has(pin.id) && pin.version !== latest.get(pin.id))
        .map((pin) => ({
          message: `${service.name} sends ${pin.id} ${pin.version}, but the latest version is ${latest.get(pin.id)}`,
          resources: [{ type: 'service', id: service.id, version: service.version }],
        }))
    );
  },
});
