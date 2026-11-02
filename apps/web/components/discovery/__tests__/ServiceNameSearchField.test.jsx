import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { ServiceNameSearchField } from '../ServiceNameSearchField';

describe('ServiceNameSearchField', () => {
  const savedFetch = global.fetch;

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = savedFetch;
  });

  it('suggests real service names and submits the selected service on Enter', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'Hair Cut', category: 'Hair' },
        { name: 'Hair Cutting', category: null },
      ],
    });
    const onChange = jest.fn();
    const onSubmit = jest.fn();
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ServiceNameSearchField value="Hair" onChange={onChange} onSubmit={onSubmit} labelledBy="service-label" />,
      );
    });
    await act(async () => {
      renderer.root.findByType('input').props.onFocus();
    });
    await act(async () => {
      jest.advanceTimersByTime(310);
      await Promise.resolve();
      await Promise.resolve();
    });
    const calledUrl = global.fetch.mock.calls[0][0];
    const url = new URL(calledUrl, 'http://localhost');
    expect(url.pathname).toMatch(/\/salons\/service-suggestions$/);
    expect(url.searchParams.get('q')).toBe('Hair');
    expect(url.searchParams.has('shopName')).toBe(false);
    const input = renderer.root.findByType('input');
    expect(input.props.placeholder).toContain('service name');
    expect(input.props['aria-labelledby']).toBe('service-label');
    const opts = renderer.root.findAll((x) => x.type === 'button' && x.props.role === 'option');
    expect(opts.map((o) => o.props.children)).toEqual(['Hair Cut', 'Hair Cutting']);
    expect(opts[0].props.style.color).toBe('var(--bc-ink)');
    await act(async () => {
      input.props.onKeyDown({ key: 'Enter', preventDefault: jest.fn() });
    });
    expect(onChange).toHaveBeenCalledWith('Hair Cut');
    expect(onSubmit).toHaveBeenCalledWith('Hair Cut');
  });

  it('does not query before two letters are entered', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ServiceNameSearchField value="H" onChange={jest.fn()} onSubmit={jest.fn()} labelledBy="service-label" />,
      );
    });
    await act(async () => {
      renderer.root.findByType('input').props.onFocus();
      jest.advanceTimersByTime(1000);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
