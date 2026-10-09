import { create } from 'zustand';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import type { Story, StoryGroup } from '../lib/types';
import { useConfig } from './config';

// Your stories and those of the people you have a direct chat with.
interface StoriesState {
  mine: Story[];
  feed: StoryGroup[];
  loaded: boolean;
}

const empty: StoriesState = { mine: [], feed: [], loaded: false };

export const useStories = create<StoriesState>(() => empty);

export const resetStories = () => useStories.setState(empty, true);

let loading: Promise<void> | null = null;

export function loadStories(): Promise<void> {
  if (!useConfig.getState().features.stories) return Promise.resolve();
  loading ??= api
    .stories()
    .then((r) => useStories.setState({ ...r, loaded: true }))
    .catch(() => {})
    .finally(() => (loading = null));
  return loading;
}

/** Shows the story as seen right away and tells the server in the background. */
export function markStorySeen(story: Story) {
  if (story.seen) return;
  useStories.setState((s) => ({
    feed: s.feed.map((g) => {
      if (g.user.id !== story.userId) return g;
      const stories = g.stories.map((x) => (x.id === story.id ? { ...x, seen: true } : x));
      return { ...g, stories, unseen: stories.some((x) => !x.seen) };
    }),
  }));
  void api.viewStory(story.id).catch(() => {});
}

socket.on('stories', () => void loadStories());
socket.on('hello', () => void loadStories());
